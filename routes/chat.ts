import { Application, Request, Response } from 'express';
import { CAREGIVER_ASSISTANT_PROMPT_V1 as SOPHIE_SYSTEM_PROMPT } from '../prompts/caregiver-assistant-v1';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  language?: 'en' | 'es' | 'fr';
  visitorType?: 'prospect' | 'customer';
}

interface HealthCheckResponse {
  status: string;
  timestamp: string;
}

interface ClientInfoResponse {
  ip: string;
  userAgent: string;
  referrer: string | null;
}

export function registerChatRoutes(app: Application): void {
  // Health check
  app.get('/api/health', (_req: Request, res: Response<HealthCheckResponse>): void => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  // Client Info
  app.get('/api/client-info', (req: Request, res: Response<ClientInfoResponse>): void => {
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : req.socket.remoteAddress || 'unknown';

    res.json({
      ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      referrer: (req.headers['referer'] as string) || null,
    });
  });

  // Sophie Chatbot Streaming Proxy (SSE)
  app.post(
    '/api/chat/sophie',
    async (req: Request<object, unknown, ChatRequestBody>, res: Response): Promise<void> => {
      const { messages, language = 'en', visitorType = 'prospect' } = req.body;

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error('ANTHROPIC_API_KEY not configured');
        res.status(500).json({ success: false, error: 'Chat service not configured' });
        return;
      }

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ success: false, error: 'Messages array is required' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders();

      try {
        let systemPrompt = SOPHIE_SYSTEM_PROMPT;

        // Prepend visitor context (spec item 1.4)
        const visitorContext = visitorType === 'customer'
          ? 'VISITOR CONTEXT: Registered customer — already subscribed.\nFocus on dashboard help, feature questions, and troubleshooting.\n\n'
          : 'VISITOR CONTEXT: Prospective caregiver — not yet a customer.\nGuide them toward understanding AidFone and starting the free trial.\n\n';
        systemPrompt = visitorContext + systemPrompt;

        if (language === 'es') {
          systemPrompt += '\n\nIMPORTANT: The user has selected Spanish. Respond in Spanish (Latin American Spanish).';
        } else if (language === 'fr') {
          systemPrompt += '\n\nIMPORTANT: The user has selected French. Respond in French (Canadian French).';
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            stream: true,
            system: systemPrompt,
            messages: messages
          })
        });

        if (!response.ok) {
          const errorData = await response.text();
          console.error('Anthropic API error:', response.status, errorData);
          res.write(`data: ${JSON.stringify({ error: 'Failed to get response from AI' })}\n\n`);
          res.end();
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          res.write(`data: ${JSON.stringify({ error: 'No response body' })}\n\n`);
          res.end();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
                }
                if (parsed.type === 'message_stop') {
                  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                }
              } catch {
                // Skip non-JSON lines
              }
            }
          }
        }

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();

      } catch (err) {
        console.error('Chat proxy error:', err);
        res.write(`data: ${JSON.stringify({ error: 'Server error processing chat request' })}\n\n`);
        res.end();
      }
    }
  );
}
