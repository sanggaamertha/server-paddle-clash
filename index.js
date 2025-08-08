const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let waitingPlayer = null;
const games = {};

io.on('connection', (socket) => {
  console.log(`Pemain terhubung: ${socket.id}`);

  socket.on('findMatch', () => {
    console.log(`Pemain ${socket.id} mencari pertandingan.`);

    if (waitingPlayer) {
      const player1Socket = waitingPlayer;
      const player2Socket = socket;
      const roomId = `game_${player1Socket.id}_${player2Socket.id}`;

      console.log(`Match ditemukan: ${player1Socket.id} (Player 1) vs ${player2Socket.id} (Player 2)`);

      player1Socket.join(roomId);
      player2Socket.join(roomId);

      const initialGameState = {
        roomId: roomId,
        players: {
          [player1Socket.id]: { isPlayer1: true, score: 0 },
          [player2Socket.id]: { isPlayer1: false, score: 0 },
        },
        // State puck awal, akan dikontrol oleh Player 1
        puck: { x: 200, y: 400, vx: 150, vy: -150 },
      };

      games[roomId] = initialGameState;

      // Kirim event 'matchFound' ke kedua pemain
      // Memberi tahu setiap pemain apa perannya
      io.to(player1Socket.id).emit('matchFound', { ...initialGameState, yourRole: 'Player1' });
      io.to(player2Socket.id).emit('matchFound', { ...initialGameState, yourRole: 'Player2' });

      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waitingForMatch');
    }
  });

  // Menerima update state dari pemain (paddle)
  socket.on('playerStateUpdate', ({ roomId, paddleState }) => {
    // Langsung teruskan state paddle ke pemain lawan
    socket.to(roomId).emit('opponentStateUpdate', paddleState);
  });

  // Menerima update state puck (HANYA DARI PLAYER 1)
  socket.on('puckStateUpdate', ({ roomId, puckState }) => {
    const game = games[roomId];
    if (game) {
        game.puck = puckState; // Simpan state terbaru di server
        // Teruskan state puck ke pemain lawan (Player 2)
        socket.to(roomId).emit('puckStateUpdate', puckState);
    }
  });

  // Menerima event gol (HANYA DARI PLAYER 1)
  socket.on('goalScored', ({ roomId, scorerIsPlayer1 }) => {
      const game = games[roomId];
      if (game) {
          const player1Id = Object.keys(game.players).find(id => game.players[id].isPlayer1);
          const player2Id = Object.keys(game.players).find(id => !game.players[id].isPlayer1);
          
          if (scorerIsPlayer1) {
              game.players[player1Id].score++;
          } else {
              game.players[player2Id].score++;
          }
          console.log(`Gol! Skor baru: ${JSON.stringify(game.players)}`);
          
          // Siarkan skor baru ke semua pemain di room
          io.to(roomId).emit('scoreUpdate', { players: game.players });
      }
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id && games[roomId]) {
        console.log(`Pemain ${socket.id} keluar dari game ${roomId}`);
        socket.to(roomId).emit('opponentLeft');
        delete games[roomId];
      }
    }
    if (waitingPlayer && waitingPlayer.id === socket.id) {
        waitingPlayer = null;
    }
  });

  socket.on('disconnect', () => {
    console.log(`Pemain terputus: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server Paddle Clash (Revisi) berjalan di port ${PORT}`);
});