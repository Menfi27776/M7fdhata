const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Telegraf } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// 1. 🔐 LOAD ENVIRONMENT VARIABLES & SECRETS
// ============================================================================

let serviceAccount = null;
let ADMIN_ID = null;
let ADMIN_PASSWORD = null;
let BOT_TOKEN = null;
let WITHDRAWAL_GROUP_ID = null;
let APP_URL = null;
let BOT_USERNAME = null;

// Load Firebase Admin Key
try {
    const firebasePath = '/etc/secrets/firebase-admin-key.json';
    if (fs.existsSync(firebasePath)) {
        serviceAccount = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
        console.log('✅ Firebase Admin key loaded');
    } else {
        console.log('⚠️ firebase-admin-key.json not found at:', firebasePath);
    }
} catch (error) {
    console.error('❌ Firebase Admin key error:', error.message);
}

// Load Admin Config
try {
    const adminPath = '/etc/secrets/admin-config.json';
    if (fs.existsSync(adminPath)) {
        const adminConfig = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
        ADMIN_ID = adminConfig.admin_id;
        ADMIN_PASSWORD = adminConfig.admin_password;
        console.log('✅ Admin config loaded | ID:', ADMIN_ID);
    }
} catch (error) {
    console.error('❌ Admin config error:', error.message);
}

// Environment Variables
BOT_TOKEN = process.env.BOT_TOKEN;
WITHDRAWAL_GROUP_ID = process.env.WITHDRAWAL_GROUP_ID;
APP_URL = process.env.APP_URL;

// ============================================================================
// 2. ⚙️ APPLICATION CONFIGURATION
// ============================================================================

const APP_CONFIG = {
    welcomeBonus: 7.5,
    referralBonus: 5,
    minWithdrawUSDT: 50,
    maxWithdrawUSDT: 5000,
    syncInterval: 3600000,
    rateLimitWindow: 60000,
    rateLimitMax: 30
};

const REQUIRED_CHANNELS = [
    { name: 'Daily Airdrop X', username: '@Daily_AirdropX' },
    { name: 'Airdrop Master VIP', username: '@Airdrop_MasterVIP' },
    { name: 'Realfinance REFI', username: '@Realfinance_REFI' }
];

// ============================================================================
// 3. 🛠️ HELPER FUNCTIONS
// ============================================================================

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatUSD(amount) {
    return `$${amount.toFixed(2)} USDT`;
}

function isValidBEP20(address) {
    return /^0x[a-fA-F0-9]{40}$/i.test(address);
}

function isAdmin(userId) {
    return userId === ADMIN_ID;
}

// ============================================================================
// 4. 🛡️ RATE LIMITING SYSTEM
// ============================================================================

class RateLimiter {
    constructor(windowMs = 60000, maxRequests = 30) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this.requests = new Map();
    }

    isRateLimited(userId) {
        const now = Date.now();
        const userRequests = this.requests.get(userId) || [];
        const validRequests = userRequests.filter(timestamp => now - timestamp < this.windowMs);
        
        if (validRequests.length >= this.maxRequests) {
            return true;
        }
        
        validRequests.push(now);
        this.requests.set(userId, validRequests);
        return false;
    }

    cleanup() {
        const now = Date.now();
        for (const [userId, timestamps] of this.requests.entries()) {
            const valid = timestamps.filter(t => now - t < this.windowMs);
            if (valid.length === 0) {
                this.requests.delete(userId);
            } else {
                this.requests.set(userId, valid);
            }
        }
    }
}

const rateLimiter = new RateLimiter(APP_CONFIG.rateLimitWindow, APP_CONFIG.rateLimitMax);
setInterval(() => rateLimiter.cleanup(), 3600000);

// ============================================================================
// 5. 💾 SMART CACHE SYSTEM
// ============================================================================

class SmartCache {
    constructor() {
        this.cache = new Map();
        this.dirtyUsers = new Set();
    }

    get(userId) {
        const user = this.cache.get(userId);
        if (user) {
            user.lastAccess = Date.now();
            return { ...user };
        }
        return null;
    }

    set(userId, userData) {
        const user = { ...userData, lastAccess: Date.now(), cachedAt: Date.now() };
        this.cache.set(userId, user);
        return user;
    }

    update(userId, updates) {
        const existing = this.cache.get(userId);
        if (existing) {
            const updated = { ...existing, ...updates, lastAccess: Date.now() };
            this.cache.set(userId, updated);
            this.dirtyUsers.add(userId);
            return updated;
        }
        return null;
    }

    async updateImmediate(userId, updates, db) {
        const updated = this.update(userId, updates);
        if (updated && db) {
            try {
                await db.collection('users').doc(userId).update(updates);
                this.dirtyUsers.delete(userId);
                console.log(`⚡ Immediate sync: ${userId}`);
            } catch (error) {
                console.error(`Immediate sync failed:`, error.message);
            }
        }
        return updated;
    }

    async syncDirtyToFirebase(db) {
        if (!db) return;
        const dirtyArray = Array.from(this.dirtyUsers);
        if (dirtyArray.length === 0) return;
        
        console.log(`🔄 Syncing ${dirtyArray.length} dirty users...`);
        let success = 0;
        
        for (const userId of dirtyArray) {
            const user = this.cache.get(userId);
            if (user) {
                try {
                    const { lastAccess, cachedAt, ...userToSave } = user;
                    await db.collection('users').doc(userId).set(userToSave, { merge: true });
                    success++;
                } catch (error) {
                    console.error(`Failed to sync ${userId}:`, error.message);
                }
            }
        }
        
        this.dirtyUsers.clear();
        console.log(`✅ Sync complete: ${success} users updated`);
    }

    getStats() {
        return { cacheSize: this.cache.size, dirtyCount: this.dirtyUsers.size };
    }
}

const smartCache = new SmartCache();

// ============================================================================
// 6. 📊 SMART USER COUNTER (NO FULL COLLECTION SCAN)
// ============================================================================

class SmartCounter {
    constructor() {
        this.cachedTotal = null;
        this.lastFetch = 0;
        this.cacheTTL = 300000;
    }

    async increment(db) {
        if (!db) return;
        try {
            const counterRef = db.collection('stats').doc('counters');
            await counterRef.set({
                totalUsers: admin.firestore.FieldValue.increment(1),
                lastUpdated: new Date().toISOString()
            }, { merge: true });
            
            if (this.cachedTotal !== null) {
                this.cachedTotal++;
                this.lastFetch = Date.now();
            }
            console.log('📊 User counter incremented');
        } catch (error) {
            console.error('Counter increment error:', error.message);
        }
    }

    async getTotal(db) {
        if (!db) return 0;
        
        if (this.cachedTotal !== null && (Date.now() - this.lastFetch) < this.cacheTTL) {
            return this.cachedTotal;
        }
        
        try {
            const counterRef = db.collection('stats').doc('counters');
            const doc = await counterRef.get();
            this.cachedTotal = doc.exists ? (doc.data().totalUsers || 0) : 0;
            this.lastFetch = Date.now();
            return this.cachedTotal;
        } catch (error) {
            console.error('Get counter error:', error.message);
            return this.cachedTotal || 0;
        }
    }
}

const smartCounter = new SmartCounter();

// ============================================================================
// 7. 🔥 FIREBASE SETUP
// ============================================================================

const admin = require('firebase-admin');
let db = null;

if (serviceAccount) {
    try {
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        db = admin.firestore();
        console.log('🔥 Firebase connected');
        
        setInterval(async () => {
            await smartCache.syncDirtyToFirebase(db);
        }, APP_CONFIG.syncInterval);
        
    } catch (error) {
        console.error('❌ Firebase init error:', error.message);
    }
}

function checkDb() {
    return db !== null;
}

// ============================================================================
// 8. 📊 USER MANAGEMENT (CACHE FIRST)
// ============================================================================

async function getUser(userId) {
    let user = smartCache.get(userId);
    if (user) return user;
    
    if (!checkDb()) return null;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
            return smartCache.set(userId, userDoc.data());
        }
        return null;
    } catch (error) {
        console.error('Get user error:', error.message);
        return null;
    }
}

async function getOrCreateUser(userId, userName, username) {
    let user = smartCache.get(userId);
    if (user) return user;
    
    if (!checkDb()) return null;
    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
            return smartCache.set(userId, userDoc.data());
        }
        
        const newUser = {
            userId,
            userName: userName || 'User',
            userUsername: username || '',
            balance: 0,
            totalEarned: 0,
            inviteCount: 0,
            referredBy: null,
            referral_clicks: 0,
            referrals: [],
            walletAddress: null,
            isVerified: false,
            verifiedAt: null,
            transactions: [],
            withdrawals: [],
            createdAt: new Date().toISOString()
        };
        
        await userRef.set(newUser);
        await smartCounter.increment(db);
        
        console.log(`✅ New user: ${userId} (${userName})`);
        return smartCache.set(userId, newUser);
        
    } catch (error) {
        console.error('Create user error:', error.message);
        return null;
    }
}

async function updateUser(userId, updates, immediate = false) {
    if (immediate) {
        return await smartCache.updateImmediate(userId, updates, db);
    }
    return smartCache.update(userId, updates);
}

async function addTransaction(userId, transaction, immediate = false) {
    const user = await getUser(userId);
    if (!user) return;
    
    const transactions = user.transactions || [];
    transactions.unshift({
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 8),
        ...transaction,
        timestamp: new Date().toISOString()
    });
    
    const limited = transactions.slice(0, 100);
    await updateUser(userId, { transactions: limited }, immediate);
}

// ============================================================================
// 9. 🔍 CHANNEL VERIFICATION
// ============================================================================

const channelStatusCache = new Map();

async function verifyChannelMembership(userId, channelUsername, forceRefresh = false) {
    const cacheKey = `${userId}_${channelUsername}`;
    
    if (!forceRefresh) {
        const cached = channelStatusCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < 30000) {
            return cached.isMember;
        }
    }
    
    try {
        const cleanChannel = channelUsername.replace('@', '');
        const chatMember = await bot.telegram.getChatMember(`@${cleanChannel}`, parseInt(userId));
        const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);
        
        channelStatusCache.set(cacheKey, { isMember, timestamp: Date.now() });
        return isMember;
        
    } catch (error) {
        return false;
    }
}

async function getMissingChannels(userId, forceRefresh = false) {
    const results = await Promise.all(REQUIRED_CHANNELS.map(async (channel) => ({
        channel,
        isMember: await verifyChannelMembership(userId, channel.username, forceRefresh)
    })));
    return results.filter(r => !r.isMember).map(r => r.channel);
}

async function isUserVerifiedInChannels(userId) {
    const missing = await getMissingChannels(userId, true);
    return missing.length === 0;
}

// ============================================================================
// 10. 🔗 REFERRAL SYSTEM
// ============================================================================

async function processReferralAfterVerification(referrerId, newUserId, newUserName) {
    if (!checkDb()) return false;
    if (referrerId === newUserId) return false;

    try {
        const referrer = await getUser(referrerId);
        if (!referrer) return false;

        const currentReferrals = referrer.referrals || [];
        if (currentReferrals.includes(newUserId)) return false;

        const newInviteCount = (referrer.inviteCount || 0) + 1;

        await updateUser(referrerId, {
            referrals: [...currentReferrals, newUserId],
            inviteCount: newInviteCount,
            balance: (referrer.balance || 0) + APP_CONFIG.referralBonus,
            totalEarned: (referrer.totalEarned || 0) + APP_CONFIG.referralBonus
        }, false);
        
        await addTransaction(referrerId, {
            type: 'referral',
            amount: APP_CONFIG.referralBonus,
            currency: 'USDT',
            status: 'completed',
            description: `Referral: ${newUserName}`
        }, false);

        await bot.telegram.sendMessage(referrerId, 
            `🎉 +${APP_CONFIG.referralBonus} USDT\n\n${escapeHtml(newUserName)} joined using your link!\nTotal referrals: ${newInviteCount}`, 
            { parse_mode: 'HTML' }
        ).catch(() => {});
        
        return true;
        
    } catch (error) {
        console.error('Referral error:', error.message);
        return false;
    }
}

// ============================================================================
// 11. 💸 WITHDRAWAL SYSTEM
// ============================================================================

const withdrawSessions = new Map();

async function createWithdrawalRequest(userId, amount, walletAddress) {
    if (!checkDb()) return { success: false, error: 'Database error' };

    try {
        const user = await getUser(userId);
        if (!user) return { success: false, error: 'User not found' };

        if (amount < APP_CONFIG.minWithdrawUSDT) {
            return { success: false, error: `Minimum withdrawal: ${APP_CONFIG.minWithdrawUSDT} USDT` };
        }
        
        if (amount > APP_CONFIG.maxWithdrawUSDT) {
            return { success: false, error: `Maximum withdrawal: ${APP_CONFIG.maxWithdrawUSDT} USDT` };
        }
        
        if (amount > (user.balance || 0)) {
            return { success: false, error: `Your balance: ${formatUSD(user.balance || 0)}` };
        }

        await updateUser(userId, { balance: (user.balance || 0) - amount }, false);

        const withdrawalRef = db.collection('withdrawals').doc();
        const requestId = withdrawalRef.id;
        const approvedAt = new Date().toISOString();

        await withdrawalRef.set({
            id: requestId,
            userId,
            userName: user.userName,
            amount,
            currency: 'USDT',
            walletAddress,
            status: 'approved',
            approvedAt: approvedAt,
            autoApproved: true,
            createdAt: new Date().toISOString()
        });

        await addTransaction(userId, {
            type: 'withdrawal',
            amount: amount,
            currency: 'USDT',
            status: 'approved',
            description: `Withdrawal to ${walletAddress.substring(0, 10)}...`
        }, false);

        const userWithdrawals = user.withdrawals || [];
        userWithdrawals.push({ 
            id: requestId, 
            amount, 
            currency: 'USDT', 
            status: 'approved', 
            approvedAt: approvedAt,
            createdAt: new Date().toISOString() 
        });
        await updateUser(userId, { withdrawals: userWithdrawals }, false);

        if (WITHDRAWAL_GROUP_ID) {
            await bot.telegram.sendMessage(WITHDRAWAL_GROUP_ID,
                `💸 NEW WITHDRAWAL\n\nUser: ${escapeHtml(user.userName)}\nID: ${userId}\nAmount: ${formatUSD(amount)}\nWallet: ${walletAddress}\nID: ${requestId}`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        return { success: true, requestId };
        
    } catch (error) {
        console.error('Withdrawal error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// 12. 🎨 KEYBOARDS
// ============================================================================

function getMainKeyboard() {
    return {
        keyboard: [
            ['💰 BALANCE', '🔗 REFERRAL'],
            ['💸 WITHDRAW', '📜 HISTORY']
        ],
        resize_keyboard: true,
        persistent: true
    };
}

function getAdminKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📊 STATS', callback_data: 'admin_stats' }],
            [{ text: '💰 ADD', callback_data: 'admin_add' }],
            [{ text: '📢 BROADCAST', callback_data: 'admin_broadcast' }],
            [{ text: '🚪 LOGOUT', callback_data: 'admin_logout' }]
        ]
    };
}

// ============================================================================
// 13. 🤖 BOT SETUP
// ============================================================================

const bot = new Telegraf(BOT_TOKEN);

bot.use((ctx, next) => {
    if (ctx.chat?.type === 'private' || ctx.callbackQuery) {
        return next();
    }
    return;
});

bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
bot.telegram.getMe().then((botInfo) => { 
    BOT_USERNAME = botInfo.username; 
    console.log(`🤖 Bot: @${BOT_USERNAME}`); 
}).catch(() => {});

// ==================== START COMMAND ====================
bot.start(async (ctx) => {
    const refCode = ctx.startPayload;
    const userId = ctx.from.id.toString();
    const userName = ctx.from.first_name || 'User';
    const userUsername = ctx.from.username || '';

    if (rateLimiter.isRateLimited(userId)) {
        return ctx.reply('⚠️ Too many requests. Please slow down.');
    }

    if (!checkDb()) {
        return ctx.reply('⚠️ Database unavailable. Try again later.');
    }

    let user = await getOrCreateUser(userId, userName, userUsername);
    if (!user) return;

    if (refCode && refCode !== userId && !user.referredBy) {
        await updateUser(userId, { referredBy: refCode }, true);
        
        const referrer = await getUser(refCode);
        if (referrer) {
            const newClicks = (referrer.referral_clicks || 0) + 1;
            await updateUser(refCode, { referral_clicks: newClicks }, false);
            
            await bot.telegram.sendMessage(refCode, 
                `👀 Someone clicked your link!\n\nThey'll earn you ${APP_CONFIG.referralBonus} USDT after verification.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        
        user = await getUser(userId);
    }

    const isVerified = await isUserVerifiedInChannels(userId);
    
    if (isVerified && !user.isVerified) {
        await updateUser(userId, { isVerified: true, verifiedAt: new Date().toISOString() }, true);
        
        if (user.balance === 0) {
            await updateUser(userId, { balance: APP_CONFIG.welcomeBonus, totalEarned: APP_CONFIG.welcomeBonus }, true);
            await addTransaction(userId, {
                type: 'welcome',
                amount: APP_CONFIG.welcomeBonus,
                currency: 'USDT',
                status: 'completed',
                description: 'Welcome bonus'
            }, true);
            
            if (user.referredBy) {
                await processReferralAfterVerification(user.referredBy, userId, user.userName);
            }
        }
        
        const updatedUser = await getUser(userId);
        await ctx.reply(
            `✅ Verified!\n\n💰 Balance: ${formatUSD(updatedUser?.balance || 0)}\n👥 Referrals: ${updatedUser?.inviteCount || 0}`,
            { parse_mode: 'HTML', reply_markup: getMainKeyboard() }
        );
        return;
    }
    
    if (isVerified && user.isVerified) {
        await ctx.reply(
            `🎯 Welcome back, ${escapeHtml(userName)}!\n\n💰 Balance: ${formatUSD(user.balance || 0)}\n👥 Referrals: ${user.inviteCount || 0}`,
            { parse_mode: 'HTML', reply_markup: getMainKeyboard() }
        );
        return;
    }
    
    const channelsList = REQUIRED_CHANNELS.map(ch => `• ${ch.name}`).join('\n');
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '📢 Join Daily Airdrop X', url: 'https://t.me/Daily_AirdropX' }],
            [{ text: '📢 Join Airdrop Master VIP', url: 'https://t.me/Airdrop_MasterVIP' }],
            [{ text: '📢 Join Realfinance REFI', url: 'https://t.me/Realfinance_REFI' }],
            [{ text: '🐦 Follow on X', url: 'https://twitter.com/Daily_AirdropX' }],
            [{ text: '✅ VERIFY', callback_data: 'verify_membership' }]
        ]
    };
    
    await ctx.reply(
        `🎯 Welcome ${escapeHtml(userName)}!\n\nJoin channels & verify to get ${APP_CONFIG.welcomeBonus} USDT\nInvite friends → ${APP_CONFIG.referralBonus} USDT each\nMin withdrawal: ${APP_CONFIG.minWithdrawUSDT} USDT\n\n📢 Required channels:\n${channelsList}\n\n👇 Click VERIFY to start`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

// ==================== BALANCE ====================
bot.hears('💰 BALANCE', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = await getUser(userId);
    if (!user) return;
    
    await ctx.reply(
        `💰 Balance: ${formatUSD(user.balance || 0)}\n👥 Referrals: ${user.inviteCount || 0}\n💵 Total earned: ${formatUSD(user.totalEarned || 0)}`,
        { parse_mode: 'HTML', reply_markup: getMainKeyboard() }
    );
});

// ==================== REFERRAL ====================
bot.hears('🔗 REFERRAL', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = await getUser(userId);
    if (!user) return;
    
    const link = `https://t.me/${BOT_USERNAME}?start=${userId}`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '📤 SHARE', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=Join%20Daily%20Airdrop%20and%20earn%20USDT!` }]
        ]
    };
    
    await ctx.reply(
        `🔗 Your link:\n\n<code>${link}</code>\n\nTotal referrals: ${user.inviteCount || 0}\nEarned: ${formatUSD((user.inviteCount || 0) * APP_CONFIG.referralBonus)}`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

// ==================== WITHDRAW ====================
bot.hears('💸 WITHDRAW', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = await getUser(userId);
    if (!user) return;
    
    const isVerified = await isUserVerifiedInChannels(userId);
    if (!isVerified) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ VERIFY', callback_data: 'verify_membership' }]
            ]
        };
        return ctx.reply('⚠️ You must verify channels first.', { parse_mode: 'HTML', reply_markup: keyboard });
    }
    
    if (!user.walletAddress) {
        await ctx.reply(
            `💸 Withdrawal\n\nYour balance: ${formatUSD(user.balance || 0)}\nMinimum: ${APP_CONFIG.minWithdrawUSDT} USDT\n\nSend your BEP20 address to continue.\n\nExample: <code>0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0</code>`,
            { parse_mode: 'HTML' }
        );
        withdrawSessions.set(userId, { step: 'waitingForWallet', createdAt: Date.now() });
        return;
    }
    
    const suggestions = [
        { text: `${APP_CONFIG.minWithdrawUSDT} USDT`, callback_data: `withdraw_${APP_CONFIG.minWithdrawUSDT}` },
        { text: `100 USDT`, callback_data: `withdraw_100` },
        { text: `250 USDT`, callback_data: `withdraw_250` },
        { text: `500 USDT`, callback_data: `withdraw_500` }
    ];
    
    const keyboard = {
        inline_keyboard: [
            suggestions.map(s => ({ text: s.text, callback_data: s.callback_data })),
            [{ text: '✏️ CUSTOM', callback_data: 'withdraw_custom' }]
        ]
    };
    
    await ctx.reply(
        `💸 Withdrawal\n\nBalance: ${formatUSD(user.balance || 0)}\nMinimum: ${APP_CONFIG.minWithdrawUSDT} USDT\nWallet: <code>${user.walletAddress.substring(0, 10)}...${user.walletAddress.substring(38)}</code>\n\nChoose amount:`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
    withdrawSessions.set(userId, { step: 'waitingForAmount', currency: 'USDT', createdAt: Date.now() });
});

// ==================== HISTORY ====================
bot.hears('📜 HISTORY', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = await getUser(userId);
    if (!user) return;
    
    const transactions = user.transactions || [];
    if (transactions.length === 0) {
        return ctx.reply('📭 No transactions yet.', { parse_mode: 'HTML', reply_markup: getMainKeyboard() });
    }
    
    let history = '';
    for (let i = 0; i < Math.min(transactions.length, 10); i++) {
        const tx = transactions[i];
        const date = new Date(tx.timestamp).toLocaleDateString();
        let status = tx.status === 'completed' ? '✅' : tx.status === 'approved' ? '✅' : '⏳';
        history += `\n${status} ${tx.type.toUpperCase()}: ${formatUSD(tx.amount)} (${date})`;
    }
    
    await ctx.reply(`📜 History:${history}`, { parse_mode: 'HTML', reply_markup: getMainKeyboard() });
});

// ==================== VERIFY CALLBACK ====================
bot.action('verify_membership', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery('Checking...');
    
    const missing = await getMissingChannels(userId, true);
    
    if (missing.length > 0) {
        const keyboard = { inline_keyboard: [] };
        for (const ch of missing) {
            keyboard.inline_keyboard.push([{ text: `📢 Join ${ch.name}`, url: `https://t.me/${ch.username.substring(1)}` }]);
        }
        keyboard.inline_keyboard.push([{ text: '🔄 TRY AGAIN', callback_data: 'verify_membership' }]);
        
        const list = missing.map(ch => `• ${ch.name}`).join('\n');
        await ctx.reply(`⚠️ Missing channels:\n${list}\n\nJoin and try again.`, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }
    
    const user = await getUser(userId);
    const wasVerified = user?.isVerified || false;
    
    await updateUser(userId, { isVerified: true, verifiedAt: new Date().toISOString() }, true);
    
    if (!wasVerified && (user?.balance || 0) === 0) {
        await updateUser(userId, { balance: APP_CONFIG.welcomeBonus, totalEarned: APP_CONFIG.welcomeBonus }, true);
        await addTransaction(userId, {
            type: 'welcome',
            amount: APP_CONFIG.welcomeBonus,
            currency: 'USDT',
            status: 'completed',
            description: 'Welcome bonus'
        }, true);
        
        if (user?.referredBy) {
            await processReferralAfterVerification(user.referredBy, userId, user.userName);
        }
    }
    
    const updatedUser = await getUser(userId);
    
    await ctx.reply(
        `✅ Verified!\n\n💰 Balance: ${formatUSD(updatedUser?.balance || 0)}\n👥 Referrals: ${updatedUser?.inviteCount || 0}\n💵 Total earned: ${formatUSD(updatedUser?.totalEarned || 0)}`,
        { parse_mode: 'HTML', reply_markup: getMainKeyboard() }
    );
});

// ==================== WITHDRAW CALLBACKS ====================
bot.action(/withdraw_(.+)/, async (ctx) => {
    const userId = ctx.from.id.toString();
    const amount = parseFloat(ctx.match[1]);
    await ctx.answerCbQuery();
    
    const session = withdrawSessions.get(userId);
    if (!session) return;
    
    const user = await getUser(userId);
    const balance = user?.balance || 0;
    
    if (amount < APP_CONFIG.minWithdrawUSDT || amount > APP_CONFIG.maxWithdrawUSDT || amount > balance) {
        await ctx.reply(`❌ Invalid amount. Min: ${APP_CONFIG.minWithdrawUSDT}, Max: ${APP_CONFIG.maxWithdrawUSDT}, Your balance: ${formatUSD(balance)}`, { parse_mode: 'HTML' });
        return;
    }
    
    withdrawSessions.set(userId, { ...session, amount, step: 'confirmWithdraw' });
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '✅ CONFIRM', callback_data: 'confirm_withdraw' }],
            [{ text: '🔙 BACK', callback_data: 'back_to_withdraw' }]
        ]
    };
    
    await ctx.reply(
        `Confirm withdrawal:\n\nAmount: ${formatUSD(amount)}\nWallet: <code>${user.walletAddress.substring(0, 10)}...${user.walletAddress.substring(38)}</code>`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

bot.action('withdraw_custom', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    withdrawSessions.set(userId, { step: 'waitingForCustomAmount', createdAt: Date.now() });
    await ctx.reply('Send the amount as a number.\n\nExample: 100', { parse_mode: 'HTML' });
});

bot.action('confirm_withdraw', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = withdrawSessions.get(userId);
    await ctx.answerCbQuery();
    
    if (!session?.amount) {
        await ctx.reply('Session expired. Start over.');
        return;
    }
    
    const user = await getUser(userId);
    if (!user) return;
    
    const result = await createWithdrawalRequest(userId, session.amount, user.walletAddress);
    
    if (result.success) {
        await ctx.reply(`✅ Withdrawal submitted!\n\nAmount: ${formatUSD(session.amount)}\nID: ${result.requestId}\n\nProcessing: 1-12 hours`, { parse_mode: 'HTML' });
    } else {
        await ctx.reply(`❌ Failed: ${result.error}`, { parse_mode: 'HTML' });
    }
    
    withdrawSessions.delete(userId);
});

bot.action('back_to_withdraw', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    withdrawSessions.delete(userId);
    
    const user = await getUser(userId);
    const suggestions = [
        { text: `${APP_CONFIG.minWithdrawUSDT} USDT`, callback_data: `withdraw_${APP_CONFIG.minWithdrawUSDT}` },
        { text: `100 USDT`, callback_data: `withdraw_100` },
        { text: `250 USDT`, callback_data: `withdraw_250` },
        { text: `500 USDT`, callback_data: `withdraw_500` }
    ];
    
    const keyboard = {
        inline_keyboard: [
            suggestions.map(s => ({ text: s.text, callback_data: s.callback_data })),
            [{ text: '✏️ CUSTOM', callback_data: 'withdraw_custom' }]
        ]
    };
    
    await ctx.reply(
        `💸 Withdrawal\n\nBalance: ${formatUSD(user?.balance || 0)}\nMinimum: ${APP_CONFIG.minWithdrawUSDT} USDT\n\nChoose amount:`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

// ==================== ADMIN PANEL ====================
const adminSessions = new Map();

bot.hears('👑 ADMIN PANEL', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId)) return;
    
    const session = adminSessions.get(userId);
    if (session?.authenticated) {
        const totalUsers = await smartCounter.getTotal(db);
        await ctx.reply(`👑 Admin Panel\n\nUsers: ${totalUsers}\nCache: ${smartCache.getStats().cacheSize} users`, { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' });
        return;
    }
    
    await ctx.reply('🔐 Admin password:');
    adminSessions.set(userId, { waitingForPassword: true, createdAt: Date.now() });
});

bot.action('admin_stats', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) return;
    await ctx.answerCbQuery();
    
    const totalUsers = await smartCounter.getTotal(db);
    await ctx.reply(`📊 Stats\n\nTotal users: ${totalUsers}`, { parse_mode: 'HTML' });
});

bot.action('admin_add', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) return;
    await ctx.answerCbQuery();
    
    adminSessions.get(userId).step = 'adding';
    await ctx.reply('Format: USER_ID AMOUNT\nExample: 123456789 100', { parse_mode: 'HTML' });
});

bot.action('admin_broadcast', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) return;
    await ctx.answerCbQuery();
    
    adminSessions.get(userId).step = 'broadcasting';
    await ctx.reply('Send your message to all users:', { parse_mode: 'HTML' });
});

bot.action('admin_logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    adminSessions.delete(userId);
    await ctx.reply('Logged out.');
});

// ==================== TEXT HANDLER ====================
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const messageText = ctx.message.text;
    
    if (messageText.startsWith('/')) return;
    if (['💰 BALANCE', '🔗 REFERRAL', '💸 WITHDRAW', '📜 HISTORY', '👑 ADMIN PANEL'].includes(messageText)) return;
    
    const adminSession = adminSessions.get(userId);
    
    if (adminSession?.waitingForPassword && isAdmin(userId)) {
        if (messageText === ADMIN_PASSWORD) {
            adminSessions.set(userId, { authenticated: true, createdAt: Date.now() });
            const totalUsers = await smartCounter.getTotal(db);
            await ctx.reply(`✅ Welcome Admin!\n\nUsers: ${totalUsers}`, { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' });
        } else {
            await ctx.reply('❌ Wrong password.');
            adminSessions.delete(userId);
        }
        return;
    }
    
    if (adminSession?.step === 'adding' && isAdmin(userId)) {
        const parts = messageText.trim().split(' ');
        if (parts.length === 2) {
            const targetUserId = parts[0];
            const amount = parseFloat(parts[1]);
            if (!isNaN(amount) && amount > 0) {
                const user = await getUser(targetUserId);
                await updateUser(targetUserId, { balance: (user?.balance || 0) + amount, totalEarned: (user?.totalEarned || 0) + amount }, true);
                await addTransaction(targetUserId, { type: 'admin', amount: amount, currency: 'USDT', status: 'completed', description: 'Admin added' }, true);
                await ctx.reply(`✅ Added ${formatUSD(amount)} to ${targetUserId}`);
            } else {
                await ctx.reply('❌ Invalid amount.');
            }
        } else {
            await ctx.reply('❌ Format: USER_ID AMOUNT');
        }
        adminSessions.delete(userId);
        return;
    }
    
    if (adminSession?.step === 'broadcasting' && isAdmin(userId)) {
        await ctx.reply(`📢 Broadcasting...`);
        let sent = 0, failed = 0;
        for (const [uid, _] of smartCache.cache) {
            try {
                await bot.telegram.sendMessage(uid, `📢 Announcement\n\n${messageText}`, { parse_mode: 'HTML' });
                sent++;
                await new Promise(r => setTimeout(r, 50));
            } catch (e) { failed++; }
        }
        await ctx.reply(`✅ Sent to ${sent} users (${failed} failed)`);
        adminSessions.delete(userId);
        return;
    }
    
    const session = withdrawSessions.get(userId);
    
    if (session?.step === 'waitingForWallet') {
        if (isValidBEP20(messageText)) {
            await updateUser(userId, { walletAddress: messageText }, true);
            withdrawSessions.delete(userId);
            await ctx.reply(`✅ Wallet saved!\n\n<code>${messageText}</code>`, { parse_mode: 'HTML', reply_markup: getMainKeyboard() });
        } else {
            await ctx.reply('❌ Invalid BEP20 address. Send a valid address starting with 0x...', { parse_mode: 'HTML' });
        }
        return;
    }
    
    if (session?.step === 'waitingForCustomAmount') {
        const amount = parseFloat(messageText);
        const user = await getUser(userId);
        const balance = user?.balance || 0;
        
        if (isNaN(amount) || amount < APP_CONFIG.minWithdrawUSDT || amount > APP_CONFIG.maxWithdrawUSDT || amount > balance) {
            await ctx.reply(`❌ Invalid. Min: ${APP_CONFIG.minWithdrawUSDT}, Max: ${APP_CONFIG.maxWithdrawUSDT}, Your balance: ${formatUSD(balance)}`, { parse_mode: 'HTML' });
            return;
        }
        
        withdrawSessions.set(userId, { ...session, amount, step: 'confirmWithdraw' });
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ CONFIRM', callback_data: 'confirm_withdraw' }],
                [{ text: '🔙 BACK', callback_data: 'back_to_withdraw' }]
            ]
        };
        
        await ctx.reply(`Confirm withdrawal:\n\nAmount: ${formatUSD(amount)}`, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }
});

// ============================================================================
// 14. 🌐 API ROUTES
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'alive', timestamp: Date.now(), users: smartCache.getStats().cacheSize });
});

app.get('/api/ping', (req, res) => {
    res.json({ pong: true, timestamp: Date.now() });
});

app.get('/api/config', (req, res) => {
    res.json({
        welcomeBonus: APP_CONFIG.welcomeBonus,
        referralBonus: APP_CONFIG.referralBonus,
        minWithdraw: APP_CONFIG.minWithdrawUSDT,
        maxWithdraw: APP_CONFIG.maxWithdrawUSDT
    });
});

// ============================================================================
// 15. 🚀 START
// ============================================================================

// Auto-ping every 5 minutes
setInterval(async () => {
    try {
        await fetch(`http://localhost:${PORT}/api/ping`);
    } catch (e) {}
}, 300000);

bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🚀 Bot started'))
    .catch(err => console.error('Bot error:', err));

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║     DAILY AIRDROP BOT - LEGENDARY      ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                              ║
║  Firebase: ${db ? '✅' : '❌'}                             ║
║  Bot: ${BOT_TOKEN ? '✅' : '❌'}                           ║
║  Welcome: ${APP_CONFIG.welcomeBonus} USDT                   ║
║  Referral: ${APP_CONFIG.referralBonus} USDT                 ║
║  Min Withdraw: ${APP_CONFIG.minWithdrawUSDT} USDT           ║
╚════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.once('SIGINT', async () => {
    console.log('Shutting down...');
    await smartCache.syncDirtyToFirebase(db);
    process.exit(0);
});

process.once('SIGTERM', async () => {
    console.log('Shutting down...');
    await smartCache.syncDirtyToFirebase(db);
    process.exit(0);
});

// ============================================================================
// END
// ============================================================================
