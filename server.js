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
let firebaseWebConfig = {};
let ADMIN_ID = null;
let ADMIN_PASSWORD = null;
let BOT_TOKEN = null;
let WITHDRAWAL_GROUP_ID = null;
let OWNER_WALLET = null;
let APP_URL = null;
let BOT_USERNAME = null;

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║              🔐 LOADING CONFIGURATION                           ║');
console.log('╚════════════════════════════════════════════════════════════════╝');

// Load Firebase Admin Key
try {
    const firebasePath = '/etc/secrets/firebase-admin-key.json';
    if (fs.existsSync(firebasePath)) {
        serviceAccount = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
        console.log('✅ Firebase Admin key loaded');
    } else {
        console.log('⚠️ firebase-admin-key.json not found');
    }
} catch (error) {
    console.error('❌ Firebase Admin key error:', error.message);
}

// Load Firebase Web Config
try {
    const configPath = '/etc/secrets/firebase-web-config.json';
    if (fs.existsSync(configPath)) {
        firebaseWebConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log('✅ Firebase Web config loaded');
    } else {
        console.log('⚠️ firebase-web-config.json not found');
    }
} catch (error) {
    console.error('❌ Firebase Web config error:', error.message);
}

// Load Admin Config
try {
    const adminPath = '/etc/secrets/admin-config.json';
    if (fs.existsSync(adminPath)) {
        const adminConfig = JSON.parse(fs.readFileSync(adminPath, 'utf8'));
        ADMIN_ID = adminConfig.admin_id;
        ADMIN_PASSWORD = adminConfig.admin_password;
        console.log(`✅ Admin config loaded | ID: ${ADMIN_ID}`);
    } else {
        console.log('⚠️ admin-config.json not found');
    }
} catch (error) {
    console.error('❌ Admin config error:', error.message);
}

// Environment Variables
BOT_TOKEN = process.env.BOT_TOKEN;
WITHDRAWAL_GROUP_ID = process.env.WITHDRAWAL_GROUP_ID;
OWNER_WALLET = process.env.OWNER_WALLET;
APP_URL = process.env.APP_URL;

console.log('\n📋 ENVIRONMENT VARIABLES:');
console.log(`   BOT_TOKEN: ${BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);
console.log(`   WITHDRAWAL_GROUP_ID: ${WITHDRAWAL_GROUP_ID ? '✅ Configured' : '⚠️ Optional'}`);
console.log(`   OWNER_WALLET: ${OWNER_WALLET ? '✅ Configured' : '⚠️ Optional'}`);
console.log(`   APP_URL: ${APP_URL ? '✅ Configured' : '⚠️ Optional'}`);
console.log(`   ADMIN_ID: ${ADMIN_ID ? '✅ Configured' : '❌ Missing'}`);
console.log(`   ADMIN_PASSWORD: ${ADMIN_PASSWORD ? '✅ Configured' : '❌ Missing'}`);

// ============================================================================
// 2. ⚙️ APPLICATION CONFIGURATION
// ============================================================================

const APP_CONFIG = {
    welcomeBonus: 7.5,
    referralBonus: 5,
    minWithdrawUSDT: 50,
    maxWithdrawUSDT: 5000,
    sessionTTL: 3600000,
    adminSessionTTL: 86400000,
    syncInterval: 3600000,
    cacheTTL: 3600000,
    rateLimitWindow: 60000,
    rateLimitMax: 30,
    sessionCleanupInterval: 3600000
};

// Required Channels
const REQUIRED_CHANNELS = [
    { name: 'Daily Airdrop X', username: '@Daily_AirdropX' },
    { name: 'Airdrop Master VIP', username: '@Airdrop_MasterVIP' },
    { name: 'Realfinance REFI', username: '@Realfinance_REFI' }
];

// Social Links
const SOCIAL_LINKS = [
    { name: '📢 Daily Airdrop X', url: 'https://t.me/Daily_AirdropX', type: 'telegram' },
    { name: '📢 Airdrop Master VIP', url: 'https://t.me/Airdrop_MasterVIP', type: 'telegram' },
    { name: '📢 Realfinance REFI', url: 'https://t.me/Realfinance_REFI', type: 'telegram' },
    { name: '🐦 Twitter (X)', url: 'https://twitter.com/Daily_AirdropX', type: 'twitter' }
];

// ============================================================================
// 3. 🎨 PROFESSIONAL FORMATTING (HTML ONLY)
// ============================================================================

function formatUSD(amount) {
    return `$${amount.toFixed(2)} USDT`;
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidBEP20(address) {
    return /^0x[a-fA-F0-9]{40}$/i.test(address);
}

function isAdmin(userId) {
    const result = userId === ADMIN_ID;
    if (result) console.log(`👑 Admin access granted for: ${userId}`);
    return result;
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
            console.log(`⚠️ Rate limit exceeded for: ${userId}`);
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
// 5. 💾 SMART COUNTER (NO FULL COLLECTION SCAN)
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
            console.log(`📊 Total users from counter: ${this.cachedTotal}`);
            return this.cachedTotal;
        } catch (error) {
            console.error('Get counter error:', error.message);
            return this.cachedTotal || 0;
        }
    }
}

const smartCounter = new SmartCounter();

// ============================================================================
// 6. 💾 ADVANCED CACHE SYSTEM
// ============================================================================

class UserCache {
    constructor() {
        this.cache = new Map();
        this.dirtyUsers = new Set();
        this.stats = { hits: 0, misses: 0 };
    }

    get(userId) {
        const user = this.cache.get(userId);
        if (user) {
            user.lastAccess = Date.now();
            this.stats.hits++;
            return { ...user };
        }
        this.stats.misses++;
        return null;
    }

    set(userId, userData) {
        const user = { ...userData, lastAccess: Date.now(), cachedAt: Date.now() };
        this.cache.set(userId, user);
        console.log(`💾 Cached user: ${userId} (Total cached: ${this.cache.size})`);
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

    async syncAllToFirebase(db) {
        if (!db) return;
        const dirtyArray = Array.from(this.dirtyUsers);
        if (dirtyArray.length === 0) return;
        
        console.log(`🔄 Periodic sync: Saving ${dirtyArray.length} dirty users to Firebase...`);
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
        console.log(`✅ Periodic sync complete: ${success} users updated`);
    }

    getStats() {
        const hitRate = this.stats.hits + this.stats.misses === 0 ? 0 : ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(1);
        return { 
            cacheSize: this.cache.size, 
            dirtyCount: this.dirtyUsers.size,
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate: `${hitRate}%`
        };
    }
}

const userCache = new UserCache();

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
        console.log('🔥 Firebase initialized');
        
        setInterval(async () => {
            await userCache.syncAllToFirebase(db);
        }, APP_CONFIG.syncInterval);
        
    } catch (error) {
        console.error('❌ Firebase init error:', error.message);
    }
}

function checkDb() {
    return db !== null;
}

// ============================================================================
// 8. 📊 USER MANAGEMENT WITH CACHE
// ============================================================================

async function getUser(userId) {
    let user = userCache.get(userId);
    if (user) return user;
    
    if (!checkDb()) return null;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            return userCache.set(userId, userData);
        }
        return null;
    } catch (error) {
        console.error('Get user error:', error.message);
        return null;
    }
}

async function getOrCreateUser(userId, userName, username) {
    let user = userCache.get(userId);
    if (user) return user;
    
    if (!checkDb()) return null;
    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
            return userCache.set(userId, userDoc.data());
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
        
        console.log(`✅ New user created: ${userId} (${userName})`);
        return userCache.set(userId, newUser);
        
    } catch (error) {
        console.error('Create user error:', error.message);
        return null;
    }
}

async function updateUser(userId, updates, immediate = false) {
    if (immediate) {
        return await userCache.updateImmediate(userId, updates, db);
    }
    return userCache.update(userId, updates);
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
        const cleanChannel = channelUsername.replace('@', '').trim();
        const chatMember = await bot.telegram.getChatMember(`@${cleanChannel}`, parseInt(userId));
        const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);
        
        channelStatusCache.set(cacheKey, { isMember, timestamp: Date.now() });
        console.log(`🔍 Channel ${channelUsername}: ${isMember ? '✅' : '❌'} for user ${userId}`);
        return isMember;
        
    } catch (error) {
        console.log(`⚠️ Channel check failed for ${channelUsername}:`, error.code);
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
        console.log(`🎁 PROCESSING REFERRAL: ${referrerId} → ${newUserId}`);

        const referrer = await getUser(referrerId);
        if (!referrer) {
            console.log(`❌ Referral failed: Referrer ${referrerId} not found`);
            return false;
        }

        const currentReferrals = referrer.referrals || [];
        if (currentReferrals.includes(newUserId)) {
            console.log(`❌ Duplicate referral blocked: ${referrerId} → ${newUserId}`);
            return false;
        }

        const newInviteCount = (referrer.inviteCount || 0) + 1;

        await updateUser(referrerId, {
            referrals: [...currentReferrals, newUserId],
            inviteCount: newInviteCount,
            balance: (referrer.balance || 0) + APP_CONFIG.referralBonus,
            totalEarned: (referrer.totalEarned || 0) + APP_CONFIG.referralBonus,
            lastReferralAt: new Date().toISOString()
        }, true);
        
        await addTransaction(referrerId, {
            type: 'referral',
            amount: APP_CONFIG.referralBonus,
            currency: 'USDT',
            status: 'completed',
            description: `Referral bonus for ${newUserName}`
        }, true);

        console.log(`✅ REFERRAL BONUS PAID: ${referrerId} +${APP_CONFIG.referralBonus} USDT`);
        
        await bot.telegram.sendMessage(referrerId, 
            `🎉 +${APP_CONFIG.referralBonus} USDT\n\n${escapeHtml(newUserName)} joined using your link!\nTotal referrals: ${newInviteCount}`, 
            { parse_mode: 'HTML' }
        ).catch(() => {});
        
        return true;
        
    } catch (error) {
        console.error(`❌ CRITICAL REFERRAL ERROR:`, error.message);
        return false;
    }
}

// ============================================================================
// 11. 💸 WITHDRAWAL SYSTEM (AUTO-APPROVED, NO COOLDOWN)
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

        await updateUser(userId, { balance: (user.balance || 0) - amount }, true);

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
            approvedAt: approvedAt,
            description: `Withdrawal to ${walletAddress.substring(0, 10)}...`
        }, true);

        const userWithdrawals = user.withdrawals || [];
        userWithdrawals.push({ 
            id: requestId, 
            amount, 
            currency: 'USDT', 
            status: 'approved', 
            approvedAt: approvedAt,
            createdAt: new Date().toISOString() 
        });
        await updateUser(userId, { withdrawals: userWithdrawals }, true);

        // ✅ Professional withdrawal notification to admin group
        if (WITHDRAWAL_GROUP_ID) {
            const referralCount = user.inviteCount || 0;
            
            const message = `
╔════════════════════════════════════════╗
║       💸 NEW WITHDRAWAL REQUEST        ║
╠════════════════════════════════════════╣
║                                        ║
║  👤 User: ${escapeHtml(user.userName)}
║  🆔 ID: <code>${userId}</code>
║  👥 Referrals: ${referralCount}
║                                        ║
║  💰 Amount: ${formatUSD(amount)}
║  💳 Wallet:
║  <code>${walletAddress}</code>
║                                        ║
║  🆔 Request ID:
║  <code>${requestId}</code>
║                                        ║
║  ✅ Status: Auto-approved
║  📌 Action: Send funds manually
║                                        ║
╚════════════════════════════════════════╝
            `;
            
            await bot.telegram.sendMessage(WITHDRAWAL_GROUP_ID, message, { parse_mode: 'HTML' }).catch((err) => {
                console.error('Failed to send withdrawal notification:', err.message);
            });
        }

        console.log(`✅ Withdrawal request created: ${requestId} for ${userId}`);
        return { success: true, requestId };
        
    } catch (error) {
        console.error('Withdrawal error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// 12. 🎨 KEYBOARDS
// ============================================================================

function getMainKeyboard(userId) {
    const isUserAdmin = isAdmin(userId);
    console.log(`🎛️ Building keyboard for user ${userId}, isAdmin: ${isUserAdmin}`);
    
    const keyboard = [
        ['💰 BALANCE', '🔗 REFERRAL'],
        ['💸 WITHDRAW', '📜 HISTORY'],
        ['⚙️ SETTINGS']
    ];
    if (isUserAdmin) {
        keyboard.push(['👑 ADMIN PANEL']);
        console.log('👑 Admin button added to keyboard');
    }
    return { keyboard, resize_keyboard: true, persistent: true };
}

function getAdminKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📊 STATISTICS', callback_data: 'admin_stats' }],
            [{ text: '👥 TOTAL USERS', callback_data: 'admin_users' }],
            [{ text: '💰 ADD BALANCE', callback_data: 'admin_add_balance' }],
            [{ text: '➖ REMOVE BALANCE', callback_data: 'admin_remove_balance' }],
            [{ text: '📢 BROADCAST', callback_data: 'admin_broadcast' }],
            [{ text: '🔄 SYNC CACHE', callback_data: 'admin_sync_cache' }],
            [{ text: '🚪 LOGOUT', callback_data: 'admin_logout' }]
        ]
    };
}

function getWithdrawAmountKeyboard(balance) {
    // Professional horizontal layout
    return {
        inline_keyboard: [
            [
                { text: `💰 ${APP_CONFIG.minWithdrawUSDT}`, callback_data: `withdraw_${APP_CONFIG.minWithdrawUSDT}` },
                { text: `💰 100`, callback_data: `withdraw_100` },
                { text: `💰 250`, callback_data: `withdraw_250` },
                { text: `💰 500`, callback_data: `withdraw_500` }
            ],
            [
                { text: `✏️ Custom amount`, callback_data: 'withdraw_custom' }
            ]
        ]
    };
}

function getCancelKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '❌ CANCEL', callback_data: 'cancel_action' }]
        ]
    };
}

// ============================================================================
// 13. 🤖 MAIN BOT COMMANDS & HANDLERS
// ============================================================================

const bot = new Telegraf(BOT_TOKEN);

// Prevent bot from working in groups
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

    console.log(`📨 /start command from ${userId} (${userName})`);

    if (rateLimiter.isRateLimited(userId)) {
        return ctx.reply('⚠️ Too many requests. Please slow down.');
    }

    if (!checkDb()) {
        return ctx.reply('⚠️ Database unavailable. Try again later.');
    }

    let user = await getOrCreateUser(userId, userName, userUsername);
    if (!user) return;

    if (refCode && refCode !== userId && !user.referredBy) {
        console.log(`🔗 REFERRAL CLICK: ${userId} ← ${refCode}`);
        
        await updateUser(userId, { referredBy: refCode }, true);
        
        const referrer = await getUser(refCode);
        if (referrer) {
            const newClicks = (referrer.referral_clicks || 0) + 1;
            await updateUser(refCode, { referral_clicks: newClicks }, true);
            
            await bot.telegram.sendMessage(refCode, 
                `👀 Someone clicked your referral link!\n\nThey will earn you ${APP_CONFIG.referralBonus} USDT after verification.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        
        user = await getUser(userId);
    }

    const isVerified = await isUserVerifiedInChannels(userId);
    
    if (isVerified && !user.isVerified) {
        console.log(`✅ User ${userId} verified channels`);
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
            `✅ Welcome ${escapeHtml(userName)}!\n\n💰 Balance: ${formatUSD(updatedUser?.balance || 0)}\n👥 Referrals: ${updatedUser?.inviteCount || 0}\n💵 Total earned: ${formatUSD(updatedUser?.totalEarned || 0)}`,
            { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) }
        );
        return;
    }
    
    if (isVerified && user.isVerified) {
        await ctx.reply(
            `🎯 Welcome back, ${escapeHtml(userName)}!\n\n💰 Balance: ${formatUSD(user.balance || 0)}\n👥 Referrals: ${user.inviteCount || 0}\n💵 Total earned: ${formatUSD(user.totalEarned || 0)}`,
            { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) }
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

// ==================== ADMIN COMMAND ====================
bot.command('admin', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`📨 /admin command from ${userId}`);
    
    if (!isAdmin(userId)) {
        console.log(`⛔ Non-admin ${userId} tried to access admin panel`);
        return ctx.reply('⛔ Access Denied.');
    }
    
    const session = adminSessions.get(userId);
    if (session?.authenticated) {
        const totalUsers = await smartCounter.getTotal(db);
        const cacheStats = userCache.getStats();
        await ctx.reply(
            `👑 ADMIN PANEL\n\n✅ Authenticated\n👥 Users: ${totalUsers}\n📦 Cache: ${cacheStats.cacheSize} users\n🎯 Hit rate: ${cacheStats.hitRate}\n\n✨ Withdrawals are auto-approved!`,
            { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
        );
        return;
    }
    
    await ctx.reply('🔐 Enter admin password:');
    adminSessions.set(userId, { waitingForPassword: true, createdAt: Date.now() });
});

// ==================== TEXT HANDLERS ====================
bot.hears('💰 BALANCE', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`💰 Balance request from ${userId}`);
    const user = await getUser(userId);
    if (!user) return;
    
    await ctx.reply(
        `💰 BALANCE\n\nUSDT: ${formatUSD(user.balance || 0)}\n👥 Referrals: ${user.inviteCount || 0}\n💵 Total earned: ${formatUSD(user.totalEarned || 0)}`,
        { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) }
    );
});

bot.hears('🔗 REFERRAL', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`🔗 Referral request from ${userId}`);
    const user = await getUser(userId);
    if (!user) return;
    
    const link = `https://t.me/${BOT_USERNAME}?start=${userId}`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '📤 SHARE LINK', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=Join%20Daily%20Airdrop%20and%20earn%20USDT!` }]
        ]
    };
    
    await ctx.reply(
        `🔗 YOUR REFERRAL LINK\n\n<code>${link}</code>\n\n👥 Total referrals: ${user.inviteCount || 0}\n💰 Earned: ${formatUSD((user.inviteCount || 0) * APP_CONFIG.referralBonus)}`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

bot.hears('💸 WITHDRAW', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`💸 Withdraw request from ${userId}`);
    const user = await getUser(userId);
    if (!user) return;
    
    const isVerified = await isUserVerifiedInChannels(userId);
    if (!isVerified) {
        return ctx.reply('⚠️ You must verify channels first.', { parse_mode: 'HTML' });
    }
    
    if (!user.walletAddress) {
        await ctx.reply(
            `💸 WITHDRAWAL SETUP\n\nYour balance: ${formatUSD(user.balance || 0)}\nMinimum: ${APP_CONFIG.minWithdrawUSDT} USDT\n\nSend your BEP20 wallet address.\n\nExample: <code>0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0</code>`,
            { parse_mode: 'HTML', reply_markup: getCancelKeyboard() }
        );
        withdrawSessions.set(userId, { step: 'waitingForWallet', createdAt: Date.now() });
        return;
    }
    
    const keyboard = getWithdrawAmountKeyboard(user.balance || 0);
    
    await ctx.reply(
        `💸 WITHDRAWAL\n\nBalance: ${formatUSD(user.balance || 0)}\nMinimum: ${APP_CONFIG.minWithdrawUSDT} USDT\nWallet: <code>${user.walletAddress.substring(0, 10)}...${user.walletAddress.substring(38)}</code>\n\nChoose amount:`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
    withdrawSessions.set(userId, { currency: 'USDT', step: 'waitingForAmount', createdAt: Date.now() });
});

bot.hears('📜 HISTORY', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`📜 History request from ${userId}`);
    const user = await getUser(userId);
    if (!user) return;
    
    const transactions = user.transactions || [];
    if (transactions.length === 0) {
        return ctx.reply('📭 No transactions yet.', { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) });
    }
    
    let history = '';
    for (let i = 0; i < Math.min(transactions.length, 10); i++) {
        const tx = transactions[i];
        const date = new Date(tx.timestamp).toLocaleDateString();
        let status = tx.status === 'completed' || tx.status === 'approved' ? '✅' : '⏳';
        history += `\n${status} ${tx.type.toUpperCase()}: ${formatUSD(tx.amount)} (${date})`;
    }
    
    await ctx.reply(`📜 TRANSACTION HISTORY${history}`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) });
});

bot.hears('⚙️ SETTINGS', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`⚙️ Settings request from ${userId}`);
    const user = await getUser(userId);
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '💳 CHANGE WALLET', callback_data: 'change_wallet' }],
            [{ text: '🔙 BACK', callback_data: 'back_to_menu' }]
        ]
    };
    
    await ctx.reply(
        `⚙️ SETTINGS\n\n💳 Wallet: ${user?.walletAddress ? `<code>${user.walletAddress.substring(0, 10)}...${user.walletAddress.substring(38)}</code>` : 'Not set'}\n🔐 Verified: ${user?.isVerified ? '✅ Yes' : '❌ No'}`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

bot.hears('👑 ADMIN PANEL', async (ctx) => {
    const userId = ctx.from.id.toString();
    console.log(`👑 Admin panel request from ${userId}`);
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Access Denied');
    }
    
    const session = adminSessions.get(userId);
    if (session?.authenticated) {
        const totalUsers = await smartCounter.getTotal(db);
        const cacheStats = userCache.getStats();
        await ctx.reply(
            `👑 ADMIN PANEL\n\n✅ Authenticated\n👥 Users: ${totalUsers}\n📦 Cache: ${cacheStats.cacheSize} users\n🎯 Hit rate: ${cacheStats.hitRate}`,
            { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
        );
        return;
    }
    
    await ctx.reply('🔐 Enter admin password:');
    adminSessions.set(userId, { waitingForPassword: true, createdAt: Date.now() });
});

// ==================== CALLBACK HANDLERS ====================
bot.action('verify_membership', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery('Checking channels...');
    console.log(`🔍 Verification requested for ${userId}`);
    
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
        `✅ VERIFIED!\n\n💰 Balance: ${formatUSD(updatedUser?.balance || 0)}\n👥 Referrals: ${updatedUser?.inviteCount || 0}\n💵 Total earned: ${formatUSD(updatedUser?.totalEarned || 0)}`,
        { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) }
    );
});

bot.action('change_wallet', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    console.log(`💳 Change wallet requested for ${userId}`);
    
    await ctx.reply(
        `💳 CHANGE WALLET\n\nSend your new BEP20 wallet address.\n\nExample: <code>0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0</code>`,
        { parse_mode: 'HTML', reply_markup: getCancelKeyboard() }
    );
    withdrawSessions.set(userId, { step: 'waitingForWalletUpdate', createdAt: Date.now() });
});

bot.action('back_to_menu', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    withdrawSessions.delete(userId);
    const user = await getUser(userId);
    await ctx.reply(
        `🎯 MAIN MENU\n\n💰 Balance: ${formatUSD(user?.balance || 0)}`,
        { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) }
    );
});

bot.action('cancel_action', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    withdrawSessions.delete(userId);
    const user = await getUser(userId);
    await ctx.reply(
        `❌ Action cancelled.`,
        { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) }
    );
});

// Withdraw callbacks
bot.action(/withdraw_(.+)/, async (ctx) => {
    const userId = ctx.from.id.toString();
    const amount = parseFloat(ctx.match[1]);
    await ctx.answerCbQuery();
    console.log(`💸 Withdraw amount selected: ${amount} USDT for ${userId}`);
    
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
            [{ text: '🔙 BACK', callback_data: 'back_to_menu' }]
        ]
    };
    
    await ctx.reply(
        `✅ CONFIRM WITHDRAWAL\n\nAmount: ${formatUSD(amount)}\nWallet: <code>${user.walletAddress.substring(0, 10)}...${user.walletAddress.substring(38)}</code>\n\nClick CONFIRM to submit.`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );
});

bot.action('withdraw_custom', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    withdrawSessions.set(userId, { currency: 'USDT', step: 'waitingForCustomAmount', createdAt: Date.now() });
    await ctx.reply('✏️ Enter custom amount (number only):\n\nExample: 100', { parse_mode: 'HTML' });
});

bot.action('confirm_withdraw', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = withdrawSessions.get(userId);
    await ctx.answerCbQuery();
    
    if (!session?.amount) {
        await ctx.reply('❌ Session expired. Start over.');
        return;
    }
    
    const user = await getUser(userId);
    if (!user) return;
    
    const result = await createWithdrawalRequest(userId, session.amount, user.walletAddress);
    
    if (result.success) {
        await ctx.reply(`✅ WITHDRAWAL SUBMITTED!\n\nAmount: ${formatUSD(session.amount)}\nRequest ID: ${result.requestId}\n\nProcessing: 1-12 hours`, { parse_mode: 'HTML' });
    } else {
        await ctx.reply(`❌ Withdrawal failed: ${result.error}`, { parse_mode: 'HTML' });
    }
    
    withdrawSessions.delete(userId);
});

// ==================== ADMIN PANEL ====================
const adminSessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [userId, session] of adminSessions.entries()) {
        if (session.createdAt && (now - session.createdAt) > APP_CONFIG.adminSessionTTL) {
            adminSessions.delete(userId);
        }
    }
}, APP_CONFIG.sessionCleanupInterval);

async function getBotStats() {
    const totalUsers = await smartCounter.getTotal(db);
    let totalBalance = 0;
    for (const [_, user] of userCache.cache) {
        totalBalance += user.balance || 0;
    }
    return { users: totalUsers, totalBalance };
}

async function broadcastToAllUsers(message) {
    let sent = 0, failed = 0;
    for (const [userId, _] of userCache.cache) {
        try {
            await bot.telegram.sendMessage(userId, `📢 ANNOUNCEMENT\n\n${message}`, { parse_mode: 'HTML' });
            sent++;
            await new Promise(r => setTimeout(r, 50));
        } catch (e) { failed++; }
    }
    return { sent, failed };
}

// Admin action handlers
bot.action('admin_stats', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) {
        await ctx.answerCbQuery('⛔ Unauthorized');
        return;
    }
    await ctx.answerCbQuery();
    const stats = await getBotStats();
    await ctx.reply(`📊 STATISTICS\n\n👥 Users: ${stats.users}\n💰 Total USDT: ${formatUSD(stats.totalBalance)}`);
});

bot.action('admin_users', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) {
        await ctx.answerCbQuery('⛔ Unauthorized');
        return;
    }
    await ctx.answerCbQuery();
    let verified = 0, withWallet = 0;
    for (const [_, user] of userCache.cache) {
        if (user.isVerified) verified++;
        if (user.walletAddress) withWallet++;
    }
    await ctx.reply(`👥 USERS\n\n📊 Total: ${userCache.cache.size}\n✅ Verified: ${verified}\n💳 With Wallet: ${withWallet}`);
});

bot.action('admin_add_balance', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) {
        await ctx.answerCbQuery('⛔ Unauthorized');
        return;
    }
    await ctx.answerCbQuery();
    adminSessions.get(userId).step = 'adding_balance';
    await ctx.reply('💰 ADD BALANCE\n\nFormat: USER_ID AMOUNT\nExample: 123456789 100', { parse_mode: 'HTML' });
});

bot.action('admin_remove_balance', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) {
        await ctx.answerCbQuery('⛔ Unauthorized');
        return;
    }
    await ctx.answerCbQuery();
    adminSessions.get(userId).step = 'removing_balance';
    await ctx.reply('➖ REMOVE BALANCE\n\nFormat: USER_ID AMOUNT\nExample: 123456789 50', { parse_mode: 'HTML' });
});

bot.action('admin_broadcast', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) {
        await ctx.answerCbQuery('⛔ Unauthorized');
        return;
    }
    await ctx.answerCbQuery();
    adminSessions.get(userId).step = 'broadcasting';
    await ctx.reply('📢 BROADCAST\n\nSend your message to all users:', { parse_mode: 'HTML' });
});

bot.action('admin_sync_cache', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId) || !adminSessions.get(userId)?.authenticated) {
        await ctx.answerCbQuery('⛔ Unauthorized');
        return;
    }
    await ctx.answerCbQuery('🔄 Syncing...');
    await userCache.syncAllToFirebase(db);
    await ctx.reply('✅ Cache synced to Firebase!');
});

bot.action('admin_logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    adminSessions.delete(userId);
    await ctx.reply('🔓 Logged out successfully.');
});

// ==================== TEXT MESSAGE HANDLER ====================
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const messageText = ctx.message.text;
    
    const mainButtons = ['💰 BALANCE', '🔗 REFERRAL', '💸 WITHDRAW', '📜 HISTORY', '⚙️ SETTINGS', '👑 ADMIN PANEL'];
    if (mainButtons.includes(messageText)) return;
    if (messageText.startsWith('/')) return;
    
    const adminSession = adminSessions.get(userId);
    
    if (adminSession?.waitingForPassword && isAdmin(userId)) {
        if (messageText === ADMIN_PASSWORD) {
            adminSessions.set(userId, { authenticated: true, createdAt: Date.now() });
            const totalUsers = await smartCounter.getTotal(db);
            await ctx.reply(`✅ Welcome Admin!\n\n👥 Users: ${totalUsers}`, { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' });
        } else {
            await ctx.reply('❌ Wrong password.');
            adminSessions.delete(userId);
        }
        return;
    }
    
    if (adminSession?.step === 'adding_balance' && isAdmin(userId)) {
        const parts = messageText.trim().split(' ');
        if (parts.length === 2) {
            const targetUserId = parts[0];
            const amount = parseFloat(parts[1]);
            if (!isNaN(amount) && amount > 0) {
                const user = await getUser(targetUserId);
                await updateUser(targetUserId, { balance: (user?.balance || 0) + amount, totalEarned: (user?.totalEarned || 0) + amount }, true);
                await addTransaction(targetUserId, { type: 'admin_add', amount: amount, currency: 'USDT', status: 'completed', description: 'Admin added balance' }, true);
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
    
    if (adminSession?.step === 'removing_balance' && isAdmin(userId)) {
        const parts = messageText.trim().split(' ');
        if (parts.length === 2) {
            const targetUserId = parts[0];
            const amount = parseFloat(parts[1]);
            if (!isNaN(amount) && amount > 0) {
                const user = await getUser(targetUserId);
                if ((user?.balance || 0) >= amount) {
                    await updateUser(targetUserId, { balance: (user?.balance || 0) - amount }, true);
                    await addTransaction(targetUserId, { type: 'admin_remove', amount: amount, currency: 'USDT', status: 'completed', description: 'Admin removed balance' }, true);
                    await ctx.reply(`✅ Removed ${formatUSD(amount)} from ${targetUserId}`);
                } else {
                    await ctx.reply(`❌ User balance is only ${formatUSD(user?.balance || 0)}`);
                }
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
        await ctx.reply(`📢 Broadcasting to ${userCache.cache.size} users...`);
        const result = await broadcastToAllUsers(messageText);
        await ctx.reply(`✅ Broadcast sent to ${result.sent} users (${result.failed} failed)`);
        adminSessions.delete(userId);
        return;
    }
    
    const session = withdrawSessions.get(userId);
    
    if (session?.step === 'waitingForWallet') {
        if (isValidBEP20(messageText)) {
            await updateUser(userId, { walletAddress: messageText }, true);
            withdrawSessions.delete(userId);
            const user = await getUser(userId);
            await ctx.reply(`✅ Wallet saved!\n\n<code>${messageText}</code>\n\nYou can now withdraw.`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) });
        } else {
            await ctx.reply('❌ Invalid BEP20 address. Send address starting with 0x...', { parse_mode: 'HTML' });
        }
        return;
    }
    
    if (session?.step === 'waitingForWalletUpdate') {
        if (isValidBEP20(messageText)) {
            await updateUser(userId, { walletAddress: messageText }, true);
            withdrawSessions.delete(userId);
            const user = await getUser(userId);
            await ctx.reply(`✅ Wallet updated!\n\n<code>${messageText}</code>`, { parse_mode: 'HTML', reply_markup: getMainKeyboard(userId) });
        } else {
            await ctx.reply('❌ Invalid BEP20 address.', { parse_mode: 'HTML' });
        }
        return;
    }
    
    if (session?.step === 'waitingForCustomAmount') {
        const amount = parseFloat(messageText);
        const user = await getUser(userId);
        const balance = user?.balance || 0;
        
        if (isNaN(amount) || amount < APP_CONFIG.minWithdrawUSDT || amount > APP_CONFIG.maxWithdrawUSDT || amount > balance) {
            await ctx.reply(`❌ Invalid amount.\n\nMin: ${APP_CONFIG.minWithdrawUSDT} USDT\nMax: ${APP_CONFIG.maxWithdrawUSDT} USDT\nYour balance: ${formatUSD(balance)}`, { parse_mode: 'HTML' });
            return;
        }
        
        // ✅ Fix: Save complete session with currency and amount
        withdrawSessions.set(userId, { 
            currency: 'USDT', 
            amount: amount, 
            step: 'confirmWithdraw',
            createdAt: Date.now()
        });
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ CONFIRM', callback_data: 'confirm_withdraw' }],
                [{ text: '🔙 BACK', callback_data: 'back_to_menu' }]
            ]
        };
        
        await ctx.reply(
            `✅ CONFIRM WITHDRAWAL\n\nAmount: ${formatUSD(amount)}\nWallet: <code>${user.walletAddress.substring(0, 10)}...${user.walletAddress.substring(38)}</code>\n\nClick CONFIRM to submit.`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
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
    const cacheStats = userCache.getStats();
    res.json({ 
        status: 'alive', 
        timestamp: Date.now(), 
        users: cacheStats.cacheSize,
        firebase: !!db,
        cache: cacheStats
    });
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

app.get('/api/user/:userId', async (req, res) => {
    try {
        const user = await getUser(req.params.userId);
        if (!user) return res.json({ success: false, error: 'User not found' });
        res.json({ success: true, user: {
            userId: user.userId,
            userName: user.userName,
            balance: user.balance || 0,
            totalEarned: user.totalEarned || 0,
            inviteCount: user.inviteCount || 0,
            isVerified: user.isVerified || false,
            walletAddress: user.walletAddress || null
        }});
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// 15. 🚀 START BOT & SERVER
// ============================================================================

// Auto-ping every 5 minutes
setInterval(async () => {
    try {
        const response = await fetch(`http://localhost:${PORT}/api/ping`);
        console.log(`🔄 Auto-ping at ${new Date().toISOString()}: ${response.status}`);
    } catch (error) {
        console.log('Auto-ping failed:', error.message);
    }
}, 300000);

bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🚀 Daily Airdrop Bot Started Successfully!'))
    .catch(err => console.error('❌ Bot error:', err));

app.listen(PORT, () => {
    const cacheStats = userCache.getStats();
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                     DAILY AIRDROP BOT - LEGENDARY EDITION                    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  📍 Port: ${PORT}                                                              ║
║  🔥 Firebase: ${db ? '✅ Connected' : '❌ Disconnected'}                                             ║
║  👑 Admin ID: ${ADMIN_ID ? '✅ Configured' : '❌ Missing'}                                            ║
║  🤖 Bot Token: ${BOT_TOKEN ? '✅ Configured' : '❌ Missing'}                                           ║
║  📦 Cache: ${cacheStats.cacheSize} users (${cacheStats.dirtyCount} dirty)                               ║
║  🎯 Cache Hit Rate: ${cacheStats.hitRate}                                                          ║
║  🔄 Periodic Sync: Every ${APP_CONFIG.syncInterval / 3600000} hour(s)                                    ║
║  🎁 Welcome Bonus: ${APP_CONFIG.welcomeBonus} USDT                                           ║
║  👥 Referral Bonus: ${APP_CONFIG.referralBonus} USDT                                            ║
║  💎 Min Withdraw: ${APP_CONFIG.minWithdrawUSDT} USDT                                              ║
║  💎 Max Withdraw: ${APP_CONFIG.maxWithdrawUSDT} USDT                                              ║
║  ✨ Withdrawals: AUTO-APPROVED (No Cooldown)                                                   ║
║  🛡️ Rate Limit: ${APP_CONFIG.rateLimitMax} req/${APP_CONFIG.rateLimitWindow / 1000}s                        ║
╚══════════════════════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
async function gracefulShutdown() {
    console.log('🛑 Shutting down gracefully...');
    console.log('💾 Saving all dirty users to Firebase...');
    await userCache.syncAllToFirebase(db);
    console.log('✅ All data saved. Goodbye!');
    process.exit(0);
}

process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);

// ============================================================================
// END OF FILE 🎯
// ============================================================================
