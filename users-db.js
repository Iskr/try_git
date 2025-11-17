const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');

const DB_FILE = path.join(__dirname, 'users.json');
const SALT_ROUNDS = 10;

class UsersDB {
    constructor() {
        this.users = new Map();
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;

        try {
            const data = await fs.readFile(DB_FILE, 'utf8');
            const usersArray = JSON.parse(data);
            this.users = new Map(usersArray.map(u => [u.username, u]));
            console.log(`Loaded ${this.users.size} users from database`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist, start with empty database
                console.log('Creating new users database');
                await this.save();
            } else {
                console.error('Error loading users database:', error);
            }
        }

        this.initialized = true;
    }

    async save() {
        const usersArray = Array.from(this.users.values());
        await fs.writeFile(DB_FILE, JSON.stringify(usersArray, null, 2));
    }

    async createUser(username, password) {
        if (!username || username.length < 3) {
            throw new Error('Username must be at least 3 characters');
        }

        if (!password || password.length < 6) {
            throw new Error('Password must be at least 6 characters');
        }

        // Check if user exists
        if (this.users.has(username)) {
            throw new Error('Username already exists');
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        // Load initial balance from currency config
        let initialBalance = 100; // Default
        try {
            const configData = await fs.readFile(path.join(__dirname, 'currency-config.json'), 'utf8');
            const config = JSON.parse(configData);
            initialBalance = config.currency.initialBalance || 100;
        } catch (error) {
            console.log('Could not load currency config, using default balance');
        }

        const user = {
            username,
            passwordHash,
            balance: initialBalance,
            createdAt: new Date().toISOString(),
            lastLogin: null
        };

        this.users.set(username, user);
        await this.save();

        console.log(`Created user: ${username} with initial balance: ${initialBalance}`);
        return this.getUserSafe(username);
    }

    async verifyUser(username, password) {
        const user = this.users.get(username);
        if (!user) {
            return null;
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            return null;
        }

        // Update last login
        user.lastLogin = new Date().toISOString();
        await this.save();

        return this.getUserSafe(username);
    }

    getUserSafe(username) {
        const user = this.users.get(username);
        if (!user) return null;

        // Return user without password hash
        const { passwordHash, ...safeUser } = user;
        return safeUser;
    }

    async updateBalance(username, newBalance) {
        const user = this.users.get(username);
        if (!user) {
            throw new Error('User not found');
        }

        user.balance = newBalance;
        await this.save();
        return this.getUserSafe(username);
    }

    async deductBalance(username, amount) {
        const user = this.users.get(username);
        if (!user) {
            throw new Error('User not found');
        }

        if (user.balance < amount) {
            return { success: false, balance: user.balance };
        }

        user.balance -= amount;
        await this.save();
        return { success: true, balance: user.balance };
    }

    async addBalance(username, amount) {
        const user = this.users.get(username);
        if (!user) {
            throw new Error('User not found');
        }

        user.balance += amount;
        await this.save();
        return { success: true, balance: user.balance };
    }

    getBalance(username) {
        const user = this.users.get(username);
        return user ? user.balance : null;
    }
}

module.exports = new UsersDB();
