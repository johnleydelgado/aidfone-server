import { Application, Request, Response } from 'express';
import { supabase } from '../lib/clients';

interface ErrorResponse {
  error: string;
}

interface VoiceInterpretRequest {
  seniorId: string;
  transcript: string;
}

interface VoiceInterpretResponse {
  success: boolean;
  speak: string;
  matchedContact: { name: string; phone: string } | null;
  needsEmergency: boolean;
}

export function registerVoiceRoutes(app: Application): void {
  app.post(
    '/api/voice/interpret',
    async (
      req: Request<object, VoiceInterpretResponse | ErrorResponse, VoiceInterpretRequest>,
      res: Response<VoiceInterpretResponse | ErrorResponse>
    ): Promise<void> => {
      const { seniorId, transcript } = req.body;

      if (!seniorId || !transcript) {
        res.status(400).json({ error: 'seniorId and transcript are required' });
        return;
      }

      console.log(`[Voice] senior=${seniorId} transcript="${transcript}"`);

      try {
        const { data: contacts, error: contactsError } = await supabase
          .from('senior_contacts')
          .select('name, phone, relationship, aliases')
          .eq('senior_id', seniorId)
          .order('sort_order', { ascending: true });

        if (contactsError) {
          res.status(500).json({ error: 'Failed to fetch contacts' });
          return;
        }

        const contactList = (contacts || [])
          .map((c: { name: string; phone: string; relationship?: string; aliases?: string[] }) => {
            const aliasPart = c.aliases?.length ? ` (nicknames: ${c.aliases.join(', ')})` : '';
            const relPart = c.relationship ? ` [${c.relationship}]` : '';
            return `• ${c.name}${aliasPart}${relPart} — ${c.phone}`;
          })
          .join('\n');

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          res.status(500).json({ error: 'AI service not configured' });
          return;
        }

        const systemPrompt = `You are AidFone's voice assistant helping elderly users (80+) make phone calls.

AVAILABLE CONTACTS:
${contactList}

RULES:
1. Be EXTREMELY concise. Max 1 short sentence.
2. SINGLE MATCH — set contact field + say "Calling [name] now." for ANY of these:
   - Exact name match
   - Phonetic match (skylor→Skyler, tiler→Tyler, etc.)
   - Mispronunciation or typo of a name
   - Nickname or partial name that only matches one contact
   - Relational phrase ("my son", "the doctor") that matches one contact
3. AMBIGUOUS — only when 2+ contacts are equally likely: ask "Do you mean [A] or [B]?" with contact=null.
4. NO MATCH — say "I don't have that contact. You have: [first names only]." with contact=null.
5. EMERGENCY — if user says help/fallen/i fell/emergency/scared/pain/911/urgence/aide/au secours/j'ai mal/j'ai peur/je suis tombé → set emergency=true, ask "Do you need me to call 911?"
6. Respond in the SAME language the user spoke (French or English).
7. Return ONLY valid JSON — no markdown, no extra text.

RESPONSE FORMAT:
{"speak":"...","contact":{"name":"...","phone":"..."},"emergency":false}
If no contact matched, use: "contact":null`;

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system: systemPrompt,
            messages: [{ role: 'user', content: transcript }],
          }),
        });

        if (!claudeRes.ok) {
          res.status(502).json({ error: 'AI service error' });
          return;
        }

        const claudeData = (await claudeRes.json()) as {
          content: Array<{ type: string; text: string }>;
        };

        const rawText = claudeData.content?.[0]?.text?.trim() || '{}';
        const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        const jsonText = fenceMatch ? fenceMatch[1].trim() : rawText;

        let parsed: { speak?: string; contact?: { name: string; phone: string } | null; emergency?: boolean };
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          parsed = { speak: rawText, contact: null, emergency: false };
        }

        res.json({
          success: true,
          speak: parsed.speak || "I'm sorry, I didn't understand that.",
          matchedContact: parsed.contact || null,
          needsEmergency: parsed.emergency || false,
        });

      } catch (err) {
        console.error('[Voice] Unexpected error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    }
  );
}
