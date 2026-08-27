const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB 연결 실패:', err.message);
    else console.log('SQLite 데이터베이스 연결 성공');
});

// 테이블 생성 (초기화 마이그레이션 포함)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        password TEXT,
        points INTEGER,
        role TEXT DEFAULT 'user'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS betting_bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        points INTEGER,
        tendency TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS match_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT DEFAULT 'CLOSED',
        player1_id INTEGER,
        player2_id INTEGER,
        p1_fee INTEGER DEFAULT 1000,
        p2_fee INTEGER DEFAULT 1000,
        winner INTEGER DEFAULT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        bot_id INTEGER,
        is_bot INTEGER DEFAULT 0,
        name TEXT,
        chosen_player INTEGER,
        amount INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price INTEGER,
        stock INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS match_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player1_name TEXT,
        player2_name TEXT,
        winner TEXT,
        total_pool INTEGER,
        ended_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS user_bet_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER,
        user_id INTEGER,
        user_name TEXT,
        chosen_player_name TEXT,
        bet_amount INTEGER,
        payout INTEGER,
        profit INTEGER
    )`);

    // 초기 설정값 세팅
    const initSettings = [
        ['initial_points', '1000'],
        ['win_multiplier', '2'],
        ['lose_multiplier', '0.5'],
        ['draw_multiplier', '1'],
        ['final_multiplier', '1'],
        ['store_password', '1234'],
        ['curling_reward', '200']
    ];
    initSettings.forEach(([k, v]) => {
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('${k}', '${v}')`);
    });

    db.run(`INSERT OR IGNORE INTO match_state (id, status) VALUES (1, 'CLOSED')`);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

function getSetting(key, callback) {
    db.get("SELECT value FROM settings WHERE key = ?", [key], (err, row) => {
        callback(row ? row.value : null);
    });
}

// 봇의 배팅 금액 계산 로직
function calculateBotBetAmount(botPoints) {
    if (botPoints < 200) return 0;
    if (botPoints > 1000) {
        return Math.floor(botPoints * 0.2);
    }
    return 200;
}

// 즉시 배팅 성향 봇 실행
function executeInstantBots() {
    db.get("SELECT * FROM match_state WHERE id = 1", (err, match) => {
        if (!match || match.status !== 'BETTING') return;

        db.all("SELECT * FROM betting_bots", (err, bots) => {
            if (!bots) return;
            bots.forEach(bot => {
                let chosen = null;
                if (bot.tendency === 'player1') chosen = 1;
                else if (bot.tendency === 'player2') chosen = 2;
                else if (bot.tendency === 'random') chosen = Math.random() < 0.5 ? 1 : 2;

                if (chosen !== null) {
                    const betAmt = calculateBotBetAmount(bot.points);
                    if (betAmt > 0 && bot.points >= betAmt) {
                        db.run("UPDATE betting_bots SET points = points - ? WHERE id = ?", [betAmt, bot.id]);
                        db.run("INSERT INTO bets (bot_id, is_bot, name, chosen_player, amount) VALUES (?, 1, ?, ?, ?)", [bot.id, bot.name, chosen, betAmt]);
                    }
                }
            });
        });
    });
}

// 마감 시점 배팅 성향 봇 실행 (역배, 정배)
function executeDeadlineBots(callback) {
    db.get("SELECT * FROM match_state WHERE id = 1", (err, match) => {
        if (!match || match.status !== 'BETTING') {
            if (callback) callback();
            return;
        }

        db.all("SELECT * FROM bets", (err, currentBets) => {
            let p1Total = 0, p2Total = 0;
            if (currentBets) {
                currentBets.forEach(b => {
                    if (b.chosen_player === 1) p1Total += b.amount;
                    if (b.chosen_player === 2) p2Total += b.amount;
                });
            }

            db.all("SELECT * FROM betting_bots WHERE tendency IN ('underdog', 'favorite')", (err, bots) => {
                if (!bots || bots.length === 0) {
                    if (callback) callback();
                    return;
                }

                let completed = 0;
                bots.forEach(bot => {
                    let chosen = 1;
                    if (bot.tendency === 'underdog') {
                        if (p1Total < p2Total) chosen = 1;
                        else if (p2Total < p1Total) chosen = 2;
                        else chosen = Math.random() < 0.5 ? 1 : 2;
                    } else if (bot.tendency === 'favorite') {
                        if (p1Total > p2Total) chosen = 1;
                        else if (p2Total > p1Total) chosen = 2;
                        else chosen = Math.random() < 0.5 ? 1 : 2;
                    }

                    const betAmt = calculateBotBetAmount(bot.points);
                    if (betAmt > 0 && bot.points >= betAmt) {
                        db.run("UPDATE betting_bots SET points = points - ? WHERE id = ?", [betAmt, bot.id], () => {
                            db.run("INSERT INTO bets (bot_id, is_bot, name, chosen_player, amount) VALUES (?, 1, ?, ?, ?)", [bot.id, bot.name, chosen, betAmt], () => {
                                completed++;
                                if (completed === bots.length && callback) callback();
                            });
                        });
                    } else {
                        completed++;
                        if (completed === bots.length && callback) callback();
                    }
                });
            });
        });
    });
}

// 공통 데이터 로드 함수 (비동기 처리)
function renderPage(req, res, currentUser = null) {
    const sortType = req.query.sort || 'name';

    db.all("SELECT * FROM users WHERE role = 'user'", (err, usersRaw) => {
        const users = usersRaw ? [...usersRaw].sort((a, b) => {
            if (sortType === 'points') return b.points - a.points;
            return a.name.localeCompare(b.name, 'ko');
        }) : [];

        db.all("SELECT * FROM betting_bots", (err, bots) => {
            db.all("SELECT * FROM products", (err, products) => {
                db.get("SELECT * FROM match_state WHERE id = 1", (err, match) => {
                    
                    const fetchDetails = (p1Id, p2Id) => {
                        const p1Query = p1Id ? "SELECT * FROM users WHERE id = ?" : null;
                        const p2Query = p2Id ? "SELECT * FROM users WHERE id = ?" : null;

                        const executeP1 = (cb) => { if (p1Query) db.get(p1Query, [p1Id], cb); else cb(null, null); };
                        const executeP2 = (cb) => { if (p2Query) db.get(p2Query, [p2Id], cb); else cb(null, null); };

                        executeP1((err, p1) => {
                            executeP2((err, p2) => {
                                db.all("SELECT * FROM bets", (err, bets) => {
                                    let totalPool = 0, p1Pool = 0, p2Pool = 0;
                                    let p1Bets = [], p2Bets = [];

                                    if (match && (match.status === 'BETTING' || match.status === 'CLOSED_BETTING') && bets) {
                                        bets.forEach(b => {
                                            totalPool += b.amount;
                                            if (b.chosen_player === 1) {
                                                p1Pool += b.amount;
                                                p1Bets.push({ name: b.name, amount: b.amount, is_bot: b.is_bot });
                                            } else if (b.chosen_player === 2) {
                                                p2Pool += b.amount;
                                                p2Bets.push({ name: b.name, amount: b.amount, is_bot: b.is_bot });
                                            }
                                        });
                                    }

                                    let myBet = null;
                                    if (currentUser && currentUser.role === 'user' && bets) {
                                        myBet = bets.find(b => b.user_id === currentUser.id);
                                    }

                                    db.all("SELECT * FROM match_history ORDER BY id DESC", (err, matchHistories) => {
                                        const getMyHist = (cb) => {
                                            if (currentUser && currentUser.role === 'user') {
                                                db.all("SELECT * FROM user_bet_history WHERE user_id = ? ORDER BY id DESC", [currentUser.id], cb);
                                            } else {
                                                cb(null, []);
                                            }
                                        };

                                        getMyHist((err, myHistories) => {
                                            db.all("SELECT key, value FROM settings", (err, rows) => {
                                                let settings = {};
                                                if (rows) rows.forEach(r => settings[r.key] = r.value);

                                                res.render('index', {
                                                    user: currentUser,
                                                    users,
                                                    bots: bots || [],
                                                    settings,
                                                    match: match ? { ...match, p1, p2 } : null,
                                                    pool: { total: totalPool, p1: p1Pool, p2: p2Pool, p1Bets, p2Bets },
                                                    myBet,
                                                    sort: sortType,
                                                    products: products || [],
                                                    matchHistories: matchHistories || [],
                                                    myHistories: myHistories || []
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    };

                    if (match) fetchDetails(match.player1_id, match.player2_id);
                    else fetchDetails(null, null);
                });
            });
        });
    });
}

// 라우트
app.get('/', (req, res) => {
    renderPage(req, res, null);
});

app.post('/login', (req, res) => {
    const { name, password } = req.body;

    if (name === 'Admin' && password === 'whitedog0508') {
        return renderPage(req, res, { name: 'Admin', role: 'admin' });
    }

    db.get("SELECT * FROM users WHERE name = ?", [name], (err, row) => {
        if (row) {
            if (row.password === password) {
                renderPage(req, res, row);
            } else {
                res.send("<script>alert('비밀번호가 일치하지 않습니다.'); history.back();</script>");
            }
        } else {
            getSetting('initial_points', (initPtsStr) => {
                const initPts = parseInt(initPtsStr || 1000);
                db.run("INSERT INTO users (name, password, points, role) VALUES (?, ?, ?, 'user')", [name, password, initPts], function(err) {
                    if (err) {
                        return res.send("<script>alert('계정 생성 중 오류가 발생했습니다.'); history.back();</script>");
                    }
                    const newId = this.lastID;
                    db.get("SELECT * FROM users WHERE id = ?", [newId], (err, newUser) => {
                        io.emit('refreshData');
                        renderPage(req, res, newUser);
                    });
                });
            });
        }
    });
});

app.post('/admin/add-bot', (req, res) => {
    const { name, points, tendency } = req.body;
    db.run("INSERT INTO betting_bots (name, points, tendency) VALUES (?, ?, ?)", [name, parseInt(points), tendency], (err) => {
        if (err) {
            return res.send("<script>alert('동일한 이름의 배팅봇이 이미 존재합니다.'); history.back();</script>");
        }
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/admin/update-bot', (req, res) => {
    const { botId, points, tendency } = req.body;
    db.run("UPDATE betting_bots SET points = ?, tendency = ? WHERE id = ?", [parseInt(points), tendency, botId], () => {
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/admin/delete-bot', (req, res) => {
    const { botId } = req.body;
    db.run("DELETE FROM betting_bots WHERE id = ?", [botId], () => {
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/admin/update-settings', (req, res) => {
    const { initial_points, win_multiplier, lose_multiplier, draw_multiplier, final_multiplier, store_password, curling_reward } = req.body;
    const updates = [
        ['initial_points', initial_points],
        ['win_multiplier', win_multiplier],
        ['lose_multiplier', lose_multiplier],
        ['draw_multiplier', draw_multiplier],
        ['final_multiplier', final_multiplier],
        ['store_password', store_password],
        ['curling_reward', curling_reward]
    ];
    let count = 0;
    updates.forEach(([k, v]) => {
        db.run("UPDATE settings SET value = ? WHERE key = ?", [v, k], () => {
            count++;
            if (count === updates.length) {
                io.emit('refreshData');
                res.redirect('/?admin=1');
            }
        });
    });
});

app.post('/admin/add-curling-reward', (req, res) => {
    const { userId } = req.body;
    getSetting('curling_reward', (rewardStr) => {
        const reward = parseInt(rewardStr || 200);
        db.run("UPDATE users SET points = points + ? WHERE id = ?", [reward, userId], () => {
            io.emit('refreshData');
            res.redirect('/?admin=1');
        });
    });
});

app.post('/admin/add-product', (req, res) => {
    const { name, price, stock } = req.body;
    db.run("INSERT INTO products (name, price, stock) VALUES (?, ?, ?)", [name, parseInt(price), parseInt(stock)], () => {
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/admin/update-product', (req, res) => {
    const { productId, name, price, stock } = req.body;
    db.run("UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?", [name, parseInt(price), parseInt(stock), productId], () => {
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/admin/delete-product', (req, res) => {
    const { productId } = req.body;
    db.run("DELETE FROM products WHERE id = ?", [productId], () => {
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/user/buy-product', (req, res) => {
    const { userId, productId, password } = req.body;
    getSetting('store_password', (storePwd) => {
        if (password !== storePwd) {
            return res.send("<script>alert('상품 관리자 비밀번호가 일치하지 않습니다.'); history.back();</script>");
        }

        db.get("SELECT * FROM products WHERE id = ?", [productId], (err, product) => {
            db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
                if (!product || product.stock <= 0) {
                    return res.send("<script>alert('재고가 부족하여 구매할 수 없습니다.'); history.back();</script>");
                }
                if (!user || user.points < product.price) {
                    return res.send("<script>alert('보유 포인트가 부족합니다.'); history.back();</script>");
                }

                db.run("UPDATE users SET points = points - ? WHERE id = ?", [product.price, userId]);
                db.run("UPDATE products SET stock = stock - 1 WHERE id = ?", [productId], () => {
                    io.emit('refreshData');
                    res.send("<script>alert('상품 구매가 정상적으로 승인 및 완료되었습니다!'); window.location.href='/';</script>");
                });
            });
        });
    });
});

app.post('/admin/update-points', (req, res) => {
    const { userId, points } = req.body;
    db.run("UPDATE users SET points = ? WHERE id = ?", [points, userId], () => {
        io.emit('refreshData');
        res.redirect('/?admin=1');
    });
});

app.post('/admin/start-match', (req, res) => {
    const { player1_id, player2_id, p1_fee, p2_fee } = req.body;
    if (player1_id === player2_id) {
        return res.send("<script>alert('서로 다른 플레이어를 선택해야 합니다.'); history.back();</script>");
    }

    db.get("SELECT * FROM users WHERE id = ?", [player1_id], (err, p1) => {
        db.get("SELECT * FROM users WHERE id = ?", [player2_id], (err, p2) => {
            const fee1 = parseInt(p1_fee);
            const fee2 = parseInt(p2_fee);

            if (p1.points < fee1) return res.send("<script>alert('플레이어 1의 포인트가 부족합니다.'); history.back();</script>");
            if (p2.points < fee2) return res.send("<script>alert('플레이어 2의 포인트가 부족합니다.'); history.back();</script>");

            db.run("DELETE FROM bets", () => {
                db.run("UPDATE match_state SET status = 'BETTING', player1_id = ?, player2_id = ?, p1_fee = ?, p2_fee = ?, winner = NULL WHERE id = 1", [player1_id, player2_id, fee1, fee2], () => {
                    db.run("UPDATE users SET points = points - ? WHERE id = ?", [fee1, player1_id]);
                    db.run("UPDATE users SET points = points - ? WHERE id = ?", [fee2, player2_id], () => {
                        executeInstantBots();
                        io.emit('matchStarted');
                        res.redirect('/?admin=1');
                    });
                });
            });
        });
    });
});

app.post('/admin/close-betting', (req, res) => {
    db.get("SELECT * FROM match_state WHERE id = 1", (err, match) => {
        if (!match || match.status !== 'BETTING') {
            return res.send("<script>alert('현재 베팅 진행 중인 상태가 아닙니다.'); history.back();</script>");
        }

        executeDeadlineBots(() => {
            db.run("UPDATE match_state SET status = 'CLOSED_BETTING' WHERE id = 1", () => {
                io.emit('refreshData');
                res.redirect('/?admin=1');
            });
        });
    });
});

app.post('/admin/end-match', (req, res) => {
    const { winner } = req.body;
    db.get("SELECT * FROM match_state WHERE id = 1", (err, match) => {
        if (!match || match.status !== 'CLOSED_BETTING') {
            return res.send("<script>alert('배팅을 먼저 종료한 후에 결과를 확정할 수 있습니다.'); history.back();</script>");
        }

        const winType = parseInt(winner);

        getSetting('win_multiplier', (wStr) => {
        getSetting('lose_multiplier', (lStr) => {
        getSetting('draw_multiplier', (dStr) => {
        getSetting('final_multiplier', (fStr) => {
            const wMul = parseFloat(wStr || 2);
            const lMul = parseFloat(lStr || 0.5);
            const dMul = parseFloat(dStr || 1);
            const finalMul = parseFloat(fStr || 1);

            db.get("SELECT * FROM users WHERE id = ?", [match.player1_id], (err, p1User) => {
            db.get("SELECT * FROM users WHERE id = ?", [match.player2_id], (err, p2User) => {
                let p1NewPts = 0, p2NewPts = 0;
                if (winType === 1) {
                    p1NewPts = Math.floor(match.p1_fee * wMul);
                    p2NewPts = Math.floor(match.p2_fee * lMul);
                } else if (winType === 2) {
                    p1NewPts = Math.floor(match.p1_fee * lMul);
                    p2NewPts = Math.floor(match.p2_fee * wMul);
                } else {
                    p1NewPts = Math.floor(match.p1_fee * dMul);
                    p2NewPts = Math.floor(match.p2_fee * dMul);
                }

                db.run("UPDATE users SET points = points + ? WHERE id = ?", [p1NewPts, match.player1_id]);
                db.run("UPDATE users SET points = points + ? WHERE id = ?", [p2NewPts, match.player2_id]);

                db.all("SELECT * FROM bets", (err, bets) => {
                    let totalPool = 0, winnerPool = 0;
                    if (bets) {
                        bets.forEach(b => {
                            totalPool += b.amount;
                            if (b.chosen_player === winType) winnerPool += b.amount;
                        });
                    }

                    const winnerStr = winType === 1 ? p1User.name : (winType === 2 ? p2User.name : '무승부');
                    db.run("INSERT INTO match_history (player1_name, player2_name, winner, total_pool) VALUES (?, ?, ?, ?)", [p1User.name, p2User.name, winnerStr, totalPool], function() {
                        const savedMatchId = this.lastID;

                        if (bets) {
                            bets.forEach(b => {
                                let returnPoints = 0;
                                if (winType === 0) {
                                    returnPoints = b.amount;
                                } else if (b.chosen_player === winType) {
                                    if (winnerPool > 0) {
                                        returnPoints = Math.floor(b.amount * (totalPool / winnerPool) * finalMul);
                                    } else {
                                        returnPoints = Math.floor(b.amount * finalMul);
                                    }
                                } else {
                                    returnPoints = 0;
                                }

                                if (b.is_bot === 1) {
                                    if (returnPoints > 0) {
                                        db.run("UPDATE betting_bots SET points = points + ? WHERE id = ?", [returnPoints, b.bot_id]);
                                    }
                                } else {
                                    if (returnPoints > 0) {
                                        db.run("UPDATE users SET points = points + ? WHERE id = ?", [returnPoints, b.user_id]);
                                    }
                                    db.get("SELECT * FROM users WHERE id = ?", [b.user_id], (err, betUser) => {
                                        if (betUser) {
                                            const chosenName = b.chosen_player === 1 ? p1User.name : p2User.name;
                                            const profit = returnPoints - b.amount;
                                            db.run("INSERT INTO user_bet_history (match_id, user_id, user_name, chosen_player_name, bet_amount, payout, profit) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                                [savedMatchId, b.user_id, betUser.name, chosenName, b.amount, returnPoints, profit]
                                            );
                                        }
                                    });
                                }
                            });
                        }

                        db.run("UPDATE match_state SET status = 'FINISHED', winner = ? WHERE id = 1", [winType], () => {
                            io.emit('matchEnded', { winner: winType });
                            res.redirect('/?admin=1');
                        });
                    });
                });
            });
            });
        });
        });
        });
        });
    });
});

app.post('/user/place-bet', (req, res) => {
    const { userId, chosenPlayer, amount } = req.body;
    const betAmount = parseInt(amount);

    db.get("SELECT * FROM match_state WHERE id = 1", (err, match) => {
        if (!match || match.status !== 'BETTING') {
            return res.send("<script>alert('현재 베팅 가능한 시간이 아닙니다.'); history.back();</script>");
        }

        db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
            if (!user || user.points < betAmount) {
                return res.send("<script>alert('보유 포인트가 부족합니다.'); history.back();</script>");
            }

            db.get("SELECT * FROM bets WHERE user_id = ?", [userId], (err, existing) => {
                if (existing) {
                    return res.send("<script>alert('이미 베팅을 완료하셨습니다.'); history.back();</script>");
                }

                db.run("UPDATE users SET points = points - ? WHERE id = ?", [betAmount, userId], () => {
                    db.run("INSERT INTO bets (user_id, is_bot, name, chosen_player, amount) VALUES (?, 0, ?, ?, ?)", [userId, user.name, parseInt(chosenPlayer), betAmount], () => {
                        io.emit('refreshData');
                        res.redirect('/');
                    });
                });
            });
        });
    });
});

io.on('connection', (socket) => {
    console.log('클라이언트 연결됨');
});

server.listen(3000, () => {
    console.log('서버 실행 중: http://localhost:3000');
});