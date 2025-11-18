const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const usersDB = require('./users-db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize users database
usersDB.init().catch(err => {
  console.error('Failed to initialize users database:', err);
});

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size
  });
});

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Authentication endpoints
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await usersDB.createUser(username, password);
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await usersDB.verifyUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User endpoints (protected)
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = usersDB.getUserSafe(req.user.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/balance', authenticateToken, async (req, res) => {
  try {
    const balance = usersDB.getBalance(req.user.username);
    if (balance === null) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/balance/deduct', authenticateToken, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const result = await usersDB.deductBalance(req.user.username, amount);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve static files from public directory
app.use(express.static('public'));

// Store active rooms and connections
const rooms = new Map();

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let clientId = uuidv4();
  let heartbeatInterval = null;
  let isAlive = true;
  let username = null;
  let authenticated = false;

  console.log(`Client connected: ${clientId}`);

  // Setup heartbeat/ping-pong for connection health monitoring
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Start heartbeat interval
  heartbeatInterval = setInterval(() => {
    if (ws.isAlive === false) {
      console.log(`Client ${clientId} failed heartbeat check`);
      clearInterval(heartbeatInterval);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000); // Check every 30 seconds

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // Handle authentication
      if (data.type === 'authenticate') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          username = decoded.username;
          authenticated = true;

          // Get user's current balance
          const balance = usersDB.getBalance(username);

          ws.send(JSON.stringify({
            type: 'authenticated',
            username,
            balance
          }));

          console.log(`Client ${clientId} authenticated as ${username}`);
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'auth-error',
            error: 'Invalid token'
          }));
          ws.close();
        }
        return;
      }

      // Require authentication for all other messages
      if (!authenticated) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Authentication required'
        }));
        return;
      }

      switch (data.type) {
        case 'join':
          handleJoin(ws, data.roomId, clientId);
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

        case 'ping':
          // Respond to client ping with pong
          ws.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
          break;

        case 'deduct-balance':
          // Handle balance deduction from client
          try {
            const result = await usersDB.deductBalance(username, data.amount);
            ws.send(JSON.stringify({
              type: 'balance-updated',
              balance: result.balance,
              success: result.success
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'balance-error',
              error: error.message
            }));
          }
          break;

        case 'get-balance':
          // Send current balance to client
          const balance = usersDB.getBalance(username);
          ws.send(JSON.stringify({
            type: 'balance-updated',
            balance
          }));
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${clientId}`);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    if (currentRoom) {
      handleLeave(currentRoom, clientId);
    }
  });

  function handleJoin(ws, roomId, clientId) {
    currentRoom = roomId;

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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Calling service running on port ${PORT}`);
  console.log(`Server ready to accept connections`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
