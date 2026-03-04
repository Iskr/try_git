const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size
  });
});

// Serve static files from public directory
app.use(express.static('public'));

// Store active rooms and connections
const rooms = new Map();

function handleJoin(ws, roomId, clientId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  const room = rooms.get(roomId);
  room.set(clientId, ws);

  // Notify existing participants
  const participants = Array.from(room.keys()).filter(id => id !== clientId);

  ws.send(JSON.stringify({
    type: 'joined',
    roomId: roomId,
    clientId: clientId,
    participants: participants
  }));

  // Notify others about new participant
  broadcast(roomId, {
    type: 'peer-joined',
    clientId: clientId
  }, clientId);

  console.log(`Client ${clientId} joined room ${roomId}. Total participants: ${room.size}`);
}

function handleSignaling(data, roomId, senderId) {
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  const targetClient = room.get(data.targetId);

  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    targetClient.send(JSON.stringify({
      ...data,
      senderId: senderId
    }));
  }
}

function handleLeave(roomId, clientId) {
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  room.delete(clientId);

  // Notify others
  broadcast(roomId, {
    type: 'peer-left',
    clientId: clientId
  }, clientId);

  // Clean up empty rooms
  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (empty)`);
  }

  console.log(`Client ${clientId} left room ${roomId}`);
}

function broadcast(roomId, message, excludeId) {
  if (!rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  const messageStr = JSON.stringify(message);

  room.forEach((client, id) => {
    if (id !== excludeId && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  const clientId = uuidv4();
  ws.isAlive = true;

  console.log(`Client connected: ${clientId}`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Client-side ping (for browsers that don't expose WebSocket pong)
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      switch (data.type) {
        case 'join':
          currentRoom = data.roomId;
          handleJoin(ws, data.roomId, clientId);
          break;

        case 'rejoin':
          // Rejoin after reconnect — reuse clientId from client
          currentRoom = data.roomId;
          handleJoin(ws, data.roomId, data.clientId || clientId);
          break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'encryption-key':
        case 'encryption-disabled':
        case 'reaction':
          handleSignaling(data, currentRoom, clientId);
          break;

        case 'leave':
          handleLeave(currentRoom, clientId);
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${clientId}`);
    if (currentRoom) {
      handleLeave(currentRoom, clientId);
    }
  });
});

// Heartbeat: ping all clients every 30 seconds, terminate unresponsive ones
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Calling service running on port ${PORT}`);
  console.log(`Server ready to accept connections`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
