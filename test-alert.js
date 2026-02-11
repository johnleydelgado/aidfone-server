// Quick test script to trigger Socket.IO alert
const io = require('socket.io-client');

const socket = io('http://localhost:5001');

socket.on('connect', () => {
  console.log('✅ Test client connected:', socket.id);
  
  // Listen for fall alerts
  socket.on('fall_alert', (data) => {
    console.log('🚨 FALL ALERT RECEIVED:', data);
  });
  
  console.log('Listening for fall_alert events...');
  console.log('Now trigger a fall from the Android app');
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected');
});
