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

// --- KONSTANTA GAME SEPAK BOLA (Disesuaikan untuk 1v1) ---
const ARENA_WIDTH = 1000;
const ARENA_HEIGHT = 600;
const BALL_RADIUS = 30; // Bola lebih besar
const PLAYER_RADIUS = 30;
const MAX_PLAYER_SPEED = 250;
const SLIDE_SPEED = 800;
const SLIDE_DURATION = 250; // ms
const MATCHMAKING_TIMEOUT = 5000;

// --- FUNGSI MATCHMAKING ---
function startMatchmakingTimer() {
    if (matchmakingTimer) return;
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

    if (waitingPlayers.length === 1) {
        console.log("Hanya 1 pemain, menambahkan 1 bot...");
        const botId = `bot_${Date.now()}`;
        waitingPlayers.push({ id: botId, isBot: true });
    }

    const player1 = waitingPlayers[0];
    const player2 = waitingPlayers[1];
    
    const playerSockets = waitingPlayers.map(p => p.socket).filter(Boolean);

    const teamA_Ids = [player1.id];
    const teamB_Ids = [player2.id];
    
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

    const setupPlayer = (id, team, isBot) => {
        const isTeamA = team === 'teamA';
        gameState.players[id] = {
            id,
            team,
            isBot: isBot || false,
            x: ARENA_WIDTH / 2,
            y: isTeamA ? ARENA_HEIGHT * 0.75 : ARENA_HEIGHT * 0.25,
            vx: 0, vy: 0,
            lastVx: 0,
            lastVy: isTeamA ? -1 : 1, // Default menghadap gawang lawan
            isSliding: false,
            slideTimer: 0,
        };
    };

    setupPlayer(player1.id, 'teamA', player1.isBot);
    setupPlayer(player2.id, 'teamB', player2.isBot);

    games[roomId] = gameState;
    
    playerSockets.forEach(socket => {
        socket.join(roomId);
        io.to(socket.id).emit("matchFound", { ...gameState, myId: socket.id });
    });

    console.log(`Game 1v1 dimulai di room ${roomId} dengan tim:`, teamA_Ids, "vs", teamB_Ids);
    waitingPlayers = [];
}

io.on("connection", (socket) => {
    console.log(`Pemain terhubung: ${socket.id}`);

    socket.on("findMatch", () => {
        if (waitingPlayers.some(p => p.id === socket.id)) return;
        
        console.log(`Pemain ${socket.id} masuk antrean.`);
        waitingPlayers.push({ id: socket.id, socket });
        socket.emit("statusUpdate", { status: 'waiting' });

        if (waitingPlayers.length >= 2) {
            tryStartGame();
        } else {
            startMatchmakingTimer();
        }
    });

    socket.on("playerMove", ({ roomId, vx, vy }) => {
        const game = games[roomId];
        if (!game || !game.players[socket.id]) return;
        const player = game.players[socket.id];
        if (player.isBot) return;
        player.vx = vx;
        player.vy = vy;
    });

    socket.on("playerAction", ({ roomId, action, charge }) => {
       const game = games[roomId];
       if (!game || !game.players[socket.id]) return;
       const player = game.players[socket.id];
       if (player.isBot) return;

       if (action === 'slide' && !player.isSliding) {
           player.isSliding = true;
           player.slideTimer = SLIDE_DURATION;

       } else if (action === 'shoot' && game.ball.possessedBy === socket.id) {
           const { ball, players } = game;
           const player = players[socket.id];
           ball.possessedBy = null;

           let finalCharge = charge > 1.0 ? 0.1 : charge;
           const shootStrength = 300 + (finalCharge * 1200);

           let shootDirX = player.lastVx;
           let shootDirY = player.lastVy;

           const magnitude = Math.sqrt(shootDirX**2 + shootDirY**2) || 1;
           ball.vx = (shootDirX / magnitude) * shootStrength;
           ball.vy = (shootDirY / magnitude) * shootStrength;
       }
    });

    socket.on("disconnecting", () => {
        const playerIndex = waitingPlayers.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            waitingPlayers.splice(playerIndex, 1);
            console.log(`Pemain ${socket.id} keluar dari antrean.`);
        }
        
        if (waitingPlayers.length === 0) {
            stopMatchmakingTimer();
        }

        for (const roomId of socket.rooms) {
            if (roomId !== socket.id && games[roomId]) {
                console.log(`Pemain ${socket.id} keluar dari room ${roomId}. Game dihentikan.`);
                io.to(roomId).emit("statusUpdate", { status: 'opponentLeft', data: { playerId: socket.id } });
                delete games[roomId];
            }
        }
    });
});

// --- GAME LOOP ---
function gameLoop() {
    const now = Date.now();
    for (const roomId in games) {
        const game = games[roomId];
        const dt = (now - game.lastUpdate) / 1000;

        for (const playerId in game.players) {
            updatePlayer(game.players[playerId], game, dt);
        }

        updateBall(game.ball, game, dt);

        game.lastUpdate = now;
        io.to(roomId).emit("gameStateUpdate", game);
    }
}

function updatePlayer(player, game, dt) {
    if (player.isBot) {
        const ball = game.ball;
        const dirX = ball.x - player.x;
        const dirY = ball.y - player.y;
        const magnitude = Math.sqrt(dirX**2 + dirY**2) || 1;
        player.vx = dirX / magnitude;
        player.vy = dirY / magnitude;

        if (game.ball.possessedBy === player.id) {
            const shootDirY = player.team === 'teamA' ? -1 : 1;
            const shootStrength = 300;
            ball.vx = 0;
            ball.vy = shootDirY * shootStrength;
            ball.possessedBy = null;
        }
    }
    
    if (player.vx !== 0 || player.vy !== 0) {
        player.lastVx = player.vx;
        player.lastVy = player.vy;
    }
    
    if (player.isSliding) {
        player.slideTimer -= dt * 1000;
        if (player.slideTimer <= 0) {
            player.isSliding = false;
        }
        player.x += player.lastVx * SLIDE_SPEED * dt;
        player.y += player.lastVy * SLIDE_SPEED * dt;

    } else {
        player.x += player.vx * MAX_PLAYER_SPEED * dt;
        player.y += player.vy * MAX_PLAYER_SPEED * dt;
    }

    player.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, player.y));
}

function updateBall(ball, game, dt) {
    if (ball.possessedBy) {
        const owner = game.players[ball.possessedBy];
        if (owner) {
            const team = owner.team;
            const forwardY = team === 'teamA' ? -1 : 1;
            ball.x = owner.x;
            ball.y = owner.y + (forwardY * (PLAYER_RADIUS + 5));
            ball.vx = 0;
            ball.vy = 0;
        } else {
             ball.possessedBy = null;
        }
    } else {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        ball.vx *= 0.98;
        ball.vy *= 0.98;

        if (ball.x <= BALL_RADIUS || ball.x >= ARENA_WIDTH - BALL_RADIUS) ball.vx *= -0.9;
        if (ball.y <= BALL_RADIUS || ball.y >= ARENA_HEIGHT - BALL_RADIUS) ball.vy *= -0.9;
        
        let playerWithBall = null;
        let closestDist = Infinity;

        for (const playerId in game.players) {
            const player = game.players[playerId];
            const dx = ball.x - player.x;
            const dy = ball.y - player.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist < PLAYER_RADIUS + BALL_RADIUS) {
                if (player.isSliding) {
                    playerWithBall = player;
                    break;
                }
                if (dist < closestDist) {
                    closestDist = dist;
                    playerWithBall = player;
                }
            }
        }

        if (playerWithBall) {
            ball.possessedBy = playerWithBall.id;
        }
    }
    
    const goalPostWidth = ARENA_WIDTH * 0.4;
    const goalLeftX = (ARENA_WIDTH - goalPostWidth) / 2;
    const goalRightX = goalLeftX + goalPostWidth;

    let scorerTeam = null;
    if (ball.y < BALL_RADIUS) {
        if (ball.x > goalLeftX && ball.x < goalRightX) {
            scorerTeam = 'teamA';
        }
    } 
    else if (ball.y > ARENA_HEIGHT - BALL_RADIUS) {
         if (ball.x > goalLeftX && ball.x < goalRightX) {
            scorerTeam = 'teamB';
        }
    }
    
    if (scorerTeam) {
        game.teams[scorerTeam].score++;
        console.log(`GOAL! for ${scorerTeam}. Score: A=${game.teams.teamA.score}, B=${game.teams.teamB.score}`);
        ball.x = ARENA_WIDTH / 2;
        ball.y = ARENA_HEIGHT / 2;
        ball.vx = 0;
        ball.vy = 0;
        ball.possessedBy = null;
    }
}

setInterval(gameLoop, 1000 / 60);
server.listen(PORT, () => console.log(`Server sepak bola 1v1 berjalan di port ${PORT}`));