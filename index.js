const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Gunakan port dari environment variable atau default ke 3000
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: {
    origin: "*", // Izinkan koneksi dari mana saja untuk development
    methods: ["GET", "POST"]
  }
});

let waitingPlayer = null;
const games = {}; // Objek untuk menyimpan state semua game yang aktif

io.on('connection', (socket) => {
  console.log(`Pemain terhubung: ${socket.id}`);

  // Event untuk mencari lawan
  socket.on('findMatch', () => {
    console.log(`Pemain ${socket.id} mencari pertandingan.`);

    if (waitingPlayer) {
      // Lawan ditemukan! Mulai game.
      const player1 = waitingPlayer;
      const player2 = socket;
      const roomId = `game_${player1.id}_${player2.id}`;

      console.log(`Match ditemukan: ${player1.id} vs ${player2.id} di room ${roomId}`);

      // Masukkan kedua pemain ke dalam room yang sama
      player1.join(roomId);
      player2.join(roomId);

      // Inisialisasi game state untuk Paddle Clash
      // Player 1 (yang menunggu) akan di bawah (isPlayer1 = true)
      // Player 2 (yang baru datang) akan di atas (isPlayer1 = false)
      const initialGameState = {
        roomId: roomId,
        players: {
          [player1.id]: { isPlayer1: true, paddleX: 200, paddleY: 700 },
          [player2.id]: { isPlayer1: false, paddleX: 200, paddleY: 100 },
        },
        puck: { x: 200, y: 400, vx: 150, vy: -150 },
        score: { [player1.id]: 0, [player2.id]: 0 },
        turn: player1.id, // Bisa digunakan untuk menentukan siapa yang serve
        isGameOver: false,
      };

      games[roomId] = initialGameState;

      // Kirim event 'matchFound' ke kedua pemain dengan state awal
      io.to(roomId).emit('matchFound', initialGameState);

      // Reset waitingPlayer
      waitingPlayer = null;

    } else {
      // Tidak ada yang menunggu, pemain ini menjadi waitingPlayer
      waitingPlayer = socket;
      socket.emit('waitingForMatch');
    }
  });

  // Event ketika pemain menggerakkan paddle-nya
  socket.on('playerMove', ({ roomId, paddleX, paddleY }) => {
    const game = games[roomId];
    if (game && game.players[socket.id]) {
      // Update posisi paddle pemain yang mengirim event
      game.players[socket.id].paddleX = paddleX;
      game.players[socket.id].paddleY = paddleY;

      // Siarkan posisi paddle ini ke pemain LAWAN
      socket.to(roomId).emit('opponentMoved', {
        paddleX: paddleX,
        paddleY: paddleY
      });
    }
  });

  // Event ketika puck di-update (misalnya, setelah tumbukan)
  // Ini harus dikirim oleh pemain yang puck-nya berada di sisinya
  // Untuk game ini, kita akan buat player 1 (host) menjadi otoritatif untuk puck
  socket.on('puckMove', ({ roomId, puckData }) => {
    const game = games[roomId];
    if (game) {
        // Simpan state puck terbaru
        game.puck = puckData;
        // Siarkan posisi puck ke pemain lawan (player 2)
        socket.to(roomId).emit('puckUpdated', puckData);
    }
  });

  // Event ketika terjadi gol
  socket.on('goalScored', ({ roomId, scorerId }) => {
      const game = games[roomId];
      if (game && game.players[scorerId]) {
          game.score[scorerId]++;
          console.log(`Gol untuk ${scorerId}! Skor baru: ${JSON.stringify(game.score)}`);
          
          // Reset posisi puck dan siarkan skor baru
          game.puck = { x: 200, y: 400, vx: 150, vy: -150 }; // Reset puck
          
          io.to(roomId).emit('scoreUpdate', {
              score: game.score,
              puck: game.puck
          });
      }
  });


  // Menangani diskoneksi
  socket.on('disconnecting', () => {
    // Cek semua room tempat socket ini berada
    for (const roomId of socket.rooms) {
      // Jangan proses room default (yang sama dengan socket.id)
      if (roomId !== socket.id && games[roomId]) {
        console.log(`Pemain ${socket.id} keluar dari game ${roomId}`);
        
        // Beri tahu pemain lain bahwa lawannya telah pergi
        socket.to(roomId).emit('opponentLeft');
        
        // Hapus game dari memori untuk membersihkan
        delete games[roomId];
      }
    }
     // Jika pemain yang menunggu yang disconnect
    if (waitingPlayer && waitingPlayer.id === socket.id) {
        waitingPlayer = null;
        console.log('Pemain yang menunggu telah disconnect.');
    }
  });

  socket.on('disconnect', () => {
    console.log(`Pemain terputus: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server Paddle Clash berjalan di port ${PORT}`);
});
