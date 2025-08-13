// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// --- STATE MANAGEMENT ---
let waitingPlayers = [];
const games = {};
let matchmakingTimer = null;

// --- KONSTANTA GAME SEPAK BOLA ---
const ARENA_WIDTH = 500;
const ARENA_HEIGHT = 1000;
const BALL_RADIUS = 20;
const PLAYER_RADIUS = 30;
const MAX_PLAYER_SPEED = 250;
const SLIDE_SPEED = 800;
const SLIDE_DURATION = 250; // ms
const MATCHMAKING_TIMEOUT = 10000; // 10 detik

// --- FUNGSI MATCHMAKING ---
function startMatchmakingTimer() {
    if (matchmakingTimer) return; // Timer sudah berjalan
    console.log(`Matchmaking timer dimulai (${MATCHMAKING_TIMEOUT / 1000}s)`);
    matchmakingTimer = setTimeout(tryStartGame, MATCHMAKING_TIMEOUT);
}

function stopMatchmakingTimer() {
    if (matchmakingTimer) {
        clearTimeout(matchmakingTimer);
        matchmakingTimer = null;
        console.log("Matchmaking timer dihentikan.");
    }
}

function tryStartGame() {
    stopMatchmakingTimer();
    console.log(`Mencoba memulai game dengan ${waitingPlayers.length} pemain.`);

    if (waitingPlayers.length === 0) return;

    const playersNeeded = 4;
    const botsToAdd = playersNeeded - waitingPlayers.length;

    for (let i = 0; i < botsToAdd; i++) {
        const botId = `bot_${Date.now()}_${i}`;
        waitingPlayers.push({ id: botId, isBot: true });
    }

    // Acak pemain untuk membuat tim
    waitingPlayers.sort(() => Math.random() - 0.5);

    const playerSockets = waitingPlayers.map(p => p.socket).filter(Boolean); // Hanya socket pemain manusia

    const teamA_Ids = [waitingPlayers[0].id, waitingPlayers[1].id];
    const teamB_Ids = [waitingPlayers[2].id, waitingPlayers[3].id];
    
    const roomId = `game_${Date.now()}`;

    const gameState = {
        roomId,
        arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
        teams: {
            teamA: { score: 0, playerIds: teamA_Ids },
            teamB: { score: 0, playerIds: teamB_Ids }
        },
        players: {},
        ball: { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, vx: 0, vy: 0, possessedBy: null },
        lastUpdate: Date.now(),
    };

    // Atur posisi awal pemain
    const setupPlayer = (id, team, isBot, index) => {
        const isTeamA = team === 'teamA';
        gameState.players[id] = {
            id,
            team,
            isBot: isBot || false,
            x: isTeamA ? (ARENA_WIDTH / 4) * (index === 0 ? 1 : 3) : (ARENA_WIDTH / 4) * (index === 0 ? 1 : 3),
            y: isTeamA ? ARENA_HEIGHT * 0.75 : ARENA_HEIGHT * 0.25,
            vx: 0, vy: 0,
            isSliding: false,
            slideTimer: 0,
        };
    };

    waitingPlayers.slice(0, 2).forEach((p, i) => setupPlayer(p.id, 'teamA', p.isBot, i));
    waitingPlayers.slice(2, 4).forEach((p, i) => setupPlayer(p.id, 'teamB', p.isBot, i));

    games[roomId] = gameState;
    
    // Beri tahu semua pemain manusia bahwa match ditemukan
    playerSockets.forEach(socket => {
        socket.join(roomId);
        io.to(socket.id).emit("matchFound", { ...gameState, myId: socket.id });
    });

    console.log(`Game dimulai di room ${roomId} dengan tim:`, teamA_Ids, "vs", teamB_Ids);
    waitingPlayers = []; // Kosongkan antrean
}

io.on("connection", (socket) => {
    console.log(`Pemain terhubung: ${socket.id}`);

    socket.on("findMatch", () => {
        if (waitingPlayers.some(p => p.id === socket.id)) return; // Sudah di antrean
        
        console.log(`Pemain ${socket.id} masuk antrean.`);
        waitingPlayers.push({ id: socket.id, socket });
        socket.emit("statusUpdate", { status: 'waiting' });

        if (waitingPlayers.length >= 4) {
            tryStartGame();
        } else {
            startMatchmakingTimer();
        }
    });

    socket.on("playerMove", ({ roomId, vx, vy }) => {
        const game = games[roomId];
        if (!game || !game.players[socket.id]) return;
        const player = game.players[socket.id];
        player.vx = vx;
        player.vy = vy;
    });

    socket.on("playerAction", ({ roomId, action, charge }) => {
       const game = games[roomId];
       if (!game || !game.players[socket.id]) return;
       const player = game.players[socket.id];

       if (action === 'slide' && !player.isSliding) {
           player.isSliding = true;
           player.slideTimer = SLIDE_DURATION;
       } else if (action === 'shoot' && game.ball.possessedBy === socket.id) {
           const { ball } = game;
           ball.possessedBy = null;
           const shootStrength = 150 + (charge * 1000); // charge (0-1) -> strength
           
           // Arah tendangan adalah arah gerak pemain, atau ke depan jika diam
           let shootDirX = player.vx;
           let shootDirY = player.vy;
           
           if (shootDirX === 0 && shootDirY === 0) {
               const playerTeam = player.team;
               shootDirY = playerTeam === 'teamA' ? -1 : 1; // Team A menendang ke atas, B ke bawah
           }

           const magnitude = Math.sqrt(shootDirX**2 + shootDirY**2) || 1;
           ball.vx = (shootDirX / magnitude) * shootStrength;
           ball.vy = (shootDirY / magnitude) * shootStrength;
       }
    });

    socket.on("disconnecting", () => {
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        if (waitingPlayers.length < 2) stopMatchmakingTimer();

        for (const roomId of socket.rooms) {
            if (roomId !== socket.id && games[roomId]) {
                io.to(roomId).emit("opponentLeft", { playerId: socket.id });
                // Bisa diganti dengan bot jika diinginkan
                delete games[roomId]; // Untuk simple, akhiri game
            }
        }
    });
});

// --- GAME LOOP ---
function gameLoop() {
    const now = Date.now();
    for (const roomId in games) {
        const game = games[roomId];
        const dt = (now - game.lastUpdate) / 1000; // Delta time in seconds

        // Update semua pemain
        for (const playerId in game.players) {
            updatePlayer(game.players[playerId], game, dt);
        }

        // Update bola
        updateBall(game.ball, game, dt);

        game.lastUpdate = now;
        io.to(roomId).emit("gameStateUpdate", game);
    }
}

function updatePlayer(player, game, dt) {
    if (player.isSliding) {
        player.slideTimer -= dt * 1000;
        if (player.slideTimer <= 0) {
            player.isSliding = false;
        }
    }
    
    const speed = player.isSliding ? SLIDE_SPEED : MAX_PLAYER_SPEED;
    player.x += player.vx * speed * dt;
    player.y += player.vy * speed * dt;

    // Batasi pergerakan di dalam arena
    player.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, player.y));
}

function updateBall(ball, game, dt) {
    if (ball.possessedBy) {
        const owner = game.players[ball.possessedBy];
        const team = owner.team;
        // Posisi bola di depan pemain
        const forwardY = team === 'teamA' ? -1 : 1;
        ball.x = owner.x;
        ball.y = owner.y + (forwardY * (PLAYER_RADIUS + 5));
        ball.vx = 0;
        ball.vy = 0;
    } else {
        // Fisika bola bebas
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        ball.vx *= 0.98; // Gesekan
        ball.vy *= 0.98;

        // Cek tabrakan bola dengan dinding
        if (ball.x <= BALL_RADIUS || ball.x >= ARENA_WIDTH - BALL_RADIUS) ball.vx *= -0.9;
        if (ball.y <= BALL_RADIUS || ball.y >= ARENA_HEIGHT - BALL_RADIUS) ball.vy *= -0.9;
        
        // Cek tabrakan bola dengan pemain
        for (const playerId in game.players) {
            const player = game.players[playerId];
            const dx = ball.x - player.x;
            const dy = ball.y - player.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist < PLAYER_RADIUS + BALL_RADIUS) {
                if (player.isSliding) {
                    // Merebut bola dengan slide
                    ball.possessedBy = playerId;
                } else {
                    // Menguasai bola
                    ball.possessedBy = playerId;
                }
            }
        }
    }
    
    // Cek Goal
    const goalLineTop = 20;
    const goalLineBottom = ARENA_HEIGHT - 20;
    const goalLeftX = ARENA_WIDTH * 0.25;
    const goalRightX = ARENA_WIDTH * 0.75;

    let scorerTeam = null;
    if (ball.y < goalLineTop && ball.x > goalLeftX && ball.x < goalRightX) {
        scorerTeam = 'teamB'; // Team B mencetak gol di gawang atas
    } else if (ball.y > goalLineBottom && ball.x > goalLeftX && ball.x < goalRightX) {
        scorerTeam = 'teamA'; // Team A mencetak gol di gawang bawah
    }
    
    if (scorerTeam) {
        game.teams[scorerTeam].score++;
        console.log(`GOAL! for ${scorerTeam}. Skor: A=${game.teams.teamA.score}, B=${game.teams.teamB.score}`);
        // Reset posisi bola
        ball.x = ARENA_WIDTH / 2;
        ball.y = ARENA_HEIGHT / 2;
        ball.vx = 0;
        ball.vy = 0;
        ball.possessedBy = null;
    }
}

setInterval(gameLoop, 1000 / 60); // 60 FPS
server.listen(PORT, () => console.log(`Server sepak bola berjalan di port ${PORT}`));