const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const authRoutes = require('./auth');
const messageRoutes = require('./message');
const User = require('../models/User');
const ChatSession = require('../models/ChatSession');
const authMiddleware = require('./authMiddleware');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: 10e6,
});

const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json());

app.use((req, res, next) => {
  req.io = io;
  next();
});

console.log('Starting backend...');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);

mongoose.set('strictQuery', true);

app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);

app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find({}, 'username');
    res.json(users.filter((user) => user._id.toString() !== req.user.userId));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, {
    body: req.body,
    query: req.query,
    userId: req?.user?.userId
  });
  next();
});

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 20000,
  socketTimeoutMS: 45000,
  bufferCommands: false,
  autoIndex: false
})
  .then(() => console.log('MongoDB connected successfully'))
  .catch((err) => console.error('MongoDB connection error:', err));

const onlineUsers = new Set();

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);

  const token = socket.handshake.auth.token;
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.userId;
    socket.userId = userId;
    socket.join(userId);

    onlineUsers.add(userId);
    io.emit('userOnline', { userId });
    socket.emit('onlineUsers', { users: [...onlineUsers] });
  } catch (error) {
    console.log('Invalid token on socket connection:', error.message);
    socket.disconnect();
    return;
  }

  socket.on('typing', ({ receiverId }) => {
    socket.to(receiverId).emit('typing', { senderId: socket.userId, receiverId });
  });

  socket.on('stopTyping', ({ receiverId }) => {
    socket.to(receiverId).emit('stopTyping', { senderId: socket.userId, receiverId });
  });

  socket.on('sendFile', async ({ receiverId, fileData, fileName, fileType }) => {
    console.log('Received sendFile event from:', socket.userId);
    console.log('Receiver ID:', receiverId);
    console.log('File Name:', fileName);
    console.log('File Type:', fileType);
    console.log('File Data Size:', fileData.length);

    if (!receiverId || !fileData || !fileName || !fileType) {
      console.error('Missing file data fields');
      return;
    }

    try {
      const participants = [socket.userId, receiverId].sort();
      let session = await ChatSession.findOne({ participants });
      if (!session) {
        session = new ChatSession({ participants, messages: [] });
      }

      const newMessage = {
        senderId: socket.userId,
        receiverId,
        fileData,
        fileName,
        fileType,
        isFile: true,
        timestamp: new Date(),
      };
      session.messages.push(newMessage);
      await session.save();

      console.log('File saved to DB');
      io.to(receiverId).emit('receiveFile', newMessage);
      io.to(socket.userId).emit('receiveFile', newMessage);
    } catch (error) {
      console.error('Error processing sendFile:', error);
    }
  });

  socket.on('markAsSeen', async ({ senderId }) => {
    try {
      const receiverId = socket.userId;
      const participants = [senderId, receiverId].sort();
      const session = await ChatSession.findOne({ participants });
      if (session) {
        session.messages = session.messages.map((msg) => {
          if (msg.senderId.toString() === senderId && !msg.seen) {
            return { ...msg, seen: true };
          }
          return msg;
        });
        await session.save();
        io.to(senderId).emit('messageSeen', { senderId, receiverId });
      }
    } catch (error) {
      console.error('Error marking messages as seen:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      io.emit('userOffline', { userId: socket.userId });
    }
  });
});

const PORT = process.env.PORT || 3001 || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});


module.exports = app;