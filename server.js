const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

class FileTransferServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    
    // Configure CORS
    this.app.use(cors({
      origin: '*', // Adjust in production
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Rooms storage
    this.rooms = new Map();

    this.initializeRoutes();
    this.initializeWebSocket();
  }

  initializeRoutes() {
    // Health check route
    this.app.get('/', (req, res) => {
      res.json({
        status: 'File Transfer WebSocket Server',
        timestamp: new Date().toISOString()
      });
    });
  }

  initializeWebSocket() {
    this.wss.on('connection', (ws) => {
      console.log('New WebSocket connection');

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleMessage(ws, data);
        } catch (error) {
          console.error('Error parsing message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format'
          }));
        }
      });

      ws.on('close', () => {
        this.cleanupRooms(ws);
      });
    });
  }

  handleMessage(ws, message) {
    console.log('Received message:', message);

    switch (message.type) {
      case 'register':
        this.createRoom(ws, message.code);
        break;
      case 'join':
        this.joinRoom(ws, message.code);
        break;
      case 'metadata':
        this.handleMetadata(ws, message);
        break;
      case 'chunk':
        this.forwardChunk(ws, message);
        break;
      case 'complete':
        this.handleTransferComplete(ws, message);
        break;
      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
  }

  createRoom(ws, code) {
    // Validate room code
    if (!/^\d{4}$/.test(code)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid room code format'
      }));
      return;
    }

    // Check if room already exists
    if (this.rooms.has(code)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room already exists'
      }));
      return;
    }

    // Create new room
    this.rooms.set(code, {
      sender: ws,
      receiver: null,
      metadata: null,
      createdAt: Date.now(),
      lastActivity: Date.now()
    });

    ws.send(JSON.stringify({
      type: 'registered',
      code: code
    }));
  }

  joinRoom(ws, code) {
    // Validate room code
    if (!/^\d{4}$/.test(code)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid room code format'
      }));
      return;
    }

    const room = this.rooms.get(code);

    // Check room existence
    if (!room) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room does not exist or has expired'
      }));
      return;
    }

    // Check if room is already full
    if (room.receiver) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room is already occupied'
      }));
      return;
    }

    // Set receiver
    room.receiver = ws;
    room.lastActivity = Date.now();

    // Notify sender
    room.sender.send(JSON.stringify({
      type: 'peerConnected'
    }));

    ws.send(JSON.stringify({
      type: 'connected',
      code: code
    }));
  }

  handleMetadata(ws, message) {
    const room = this.findRoomByClient(ws);
    if (!room) return;

    // Validate file size
    const fileSize = parseInt(message.size);
    if (fileSize > 200 * 1024 * 1024) { // 500MB limit
      ws.send(JSON.stringify({
        type: 'error',
        message: 'File too large (max 500MB)'
      }));
      return;
    }

    // Store metadata
    room.metadata = {
      name: message.name.slice(0, 256),
      size: fileSize,
      type: message.type
    };
    room.lastActivity = Date.now();

    // Forward metadata to receiver
    if (room.receiver) {
      room.receiver.send(JSON.stringify({
        type: 'metadata',
        ...room.metadata
      }));
    }
  }

  forwardChunk(ws, message) {
    const room = this.findRoomByClient(ws);
    if (!room || !room.receiver) return;

    room.lastActivity = Date.now();
    room.receiver.send(JSON.stringify({
      type: 'chunk',
      chunk: message.chunk
    }));
  }

  handleTransferComplete(ws, message) {
    const room = this.findRoomByClient(ws);
    if (!room || !room.receiver) return;

    room.receiver.send(JSON.stringify({
      type: 'complete'
    }));

    // Clean up room after transfer
    this.rooms.delete(this.getRoomCode(ws));
  }

  findRoomByClient(ws) {
    for (const [code, room] of this.rooms.entries()) {
      if (room.sender === ws || room.receiver === ws) {
        return room;
      }
    }
    return null;
  }

  getRoomCode(ws) {
    for (const [code, room] of this.rooms.entries()) {
      if (room.sender === ws || room.receiver === ws) {
        return code;
      }
    }
    return null;
  }

  cleanupRooms(ws) {
    for (const [code, room] of this.rooms.entries()) {
      if (room.sender === ws || room.receiver === ws) {
        // Notify the other client
        const otherClient = room.sender === ws ? room.receiver : room.sender;
        if (otherClient) {
          otherClient.send(JSON.stringify({
            type: 'error',
            message: 'Peer disconnected'
          }));
        }
        
        // Remove the room
        this.rooms.delete(code);
        break;
      }
    }
  }

  start() {
    const PORT = process.env.PORT || 3000;
    this.server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}

// Start the server
const fileTransferServer = new FileTransferServer();
fileTransferServer.start();