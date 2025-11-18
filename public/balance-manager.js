// Balance Manager - управление балансом кристаллов и монетизацией

class BalanceManager {
    constructor(config) {
        this.config = config || PRICING_CONFIG;
        this.balance = this.loadBalance();
        this.totalUsedTime = this.loadUsedTime(); // в секундах
        this.callStartTime = null;
        this.timerInterval = null;
        this.encryptionPaid = false;
        this.transcriptionPaid = false;

        this.initUI();
    }

    // ===== STORAGE =====
    loadBalance() {
        const saved = localStorage.getItem('crystalBalance');
        if (saved) {
            return parseInt(saved);
        }
        // Начальный баланс для новых пользователей
        return this.config.initialBalance;
    }

    saveBalance() {
        localStorage.setItem('crystalBalance', this.balance.toString());
        this.updateBalanceDisplay();
    }

    loadUsedTime() {
        const saved = localStorage.getItem('totalUsedTime');
        return saved ? parseInt(saved) : 0;
    }

    saveUsedTime() {
        localStorage.setItem('totalUsedTime', this.totalUsedTime.toString());
    }

    // ===== UI =====
    initUI() {
        this.updateBalanceDisplay();
        this.setupEventListeners();
        this.renderPackages();
    }

    updateBalanceDisplay() {
        const balanceElements = [
            document.getElementById('balance-value'),
            document.getElementById('modal-balance')
        ];

        balanceElements.forEach(el => {
            if (el) el.textContent = this.balance;
        });

        // Warning if low balance
        if (this.balance < this.config.warnings.lowBalanceThreshold) {
            this.showWarning(`Низкий баланс! Осталось ${this.balance} ${this.config.currency.symbol}`);
        }
    }

    setupEventListeners() {
        // Open buy modal
        const addBalanceBtn = document.getElementById('add-balance-btn');
        const balanceBtn = document.getElementById('balance-btn');

        if (addBalanceBtn) {
            addBalanceBtn.addEventListener('click', () => this.openBuyModal());
        }

        if (balanceBtn) {
            balanceBtn.addEventListener('click', () => this.openBuyModal());
        }

        // Close buy modal
        const closeBtn = document.getElementById('close-buy-modal');
        const modal = document.getElementById('buy-crystals-modal');
        const overlay = modal?.querySelector('.modal-overlay');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeBuyModal());
        }

        if (overlay) {
            overlay.addEventListener('click', () => this.closeBuyModal());
        }
    }

    renderPackages() {
        const grid = document.getElementById('packages-grid');
        if (!grid) return;

        grid.innerHTML = '';

        this.config.packages.forEach(pkg => {
            const card = document.createElement('div');
            card.className = `package-card${pkg.popular ? ' popular' : ''}`;

            const totalCrystals = pkg.crystals + (pkg.bonus || 0);

            card.innerHTML = `
                <div class="package-crystals">${totalCrystals}💎</div>
                ${pkg.bonus ? `<div class="package-bonus">+${pkg.bonus} бонус!</div>` : ''}
                <div class="package-price">$${pkg.price}</div>
            `;

            card.addEventListener('click', () => this.buyPackage(pkg));
            grid.appendChild(card);
        });
    }

    openBuyModal() {
        const modal = document.getElementById('buy-crystals-modal');
        if (modal) {
            modal.classList.remove('hidden');
            this.updateBalanceDisplay(); // Update balance in modal
        }
    }

    closeBuyModal() {
        const modal = document.getElementById('buy-crystals-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    // ===== PURCHASES =====
    buyPackage(pkg) {
        // В реальном приложении здесь будет интеграция с платежной системой
        // Для демо просто добавляем кристаллы
        console.log(`Buying package: ${pkg.id} for $${pkg.price}`);

        const totalCrystals = pkg.crystals + (pkg.bonus || 0);
        this.addBalance(totalCrystals);

        this.showToast(`Куплено ${totalCrystals}💎 за $${pkg.price}! (демо режим)`);
        this.closeBuyModal();
    }

    addBalance(amount) {
        this.balance += amount;
        this.saveBalance();
        console.log(`Added ${amount} crystals. New balance: ${this.balance}`);
    }

    deductBalance(amount, reason) {
        if (this.balance >= amount) {
            this.balance -= amount;
            this.saveBalance();
            console.log(`Deducted ${amount} crystals for ${reason}. New balance: ${this.balance}`);
            return true;
        } else {
            this.showToast(`Недостаточно кристаллов! Нужно: ${amount}💎`);
            this.openBuyModal();
            return false;
        }
    }

    // ===== CALL TIMER =====
    startCallTimer() {
        this.callStartTime = Date.now();
        this.encryptionPaid = false;
        this.transcriptionPaid = false;

        this.timerInterval = setInterval(() => {
            this.updateTimer();
        }, 1000); // Update every second
    }

    stopCallTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        // Save total used time
        if (this.callStartTime) {
            const sessionDuration = Math.floor((Date.now() - this.callStartTime) / 1000);
            this.totalUsedTime += sessionDuration;
            this.saveUsedTime();
            this.callStartTime = null;
        }
    }

    updateTimer() {
        if (!this.callStartTime) return;

        const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000); // seconds
        const totalSeconds = this.totalUsedTime + elapsed;
        const totalMinutes = Math.floor(totalSeconds / 60);

        // Update timer display
        const timerText = document.getElementById('timer-text');
        const timerStatus = document.getElementById('timer-status');

        if (timerText) {
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            timerText.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        // Update status based on time
        const freeMinutes = this.config.freeTimeMinutes;

        if (totalMinutes < freeMinutes) {
            // Still in free time
            const remainingMinutes = freeMinutes - totalMinutes;

            if (timerStatus) {
                timerStatus.textContent = `Бесплатно (${remainingMinutes} мин)`;
                timerStatus.className = 'timer-free';
            }

            // Warning before free time ends
            if (remainingMinutes <= this.config.warnings.freeTimeWarning && remainingMinutes > 0) {
                if (timerStatus) {
                    timerStatus.className = 'timer-warning';
                }
            }
        } else {
            // Paid time - deduct crystals per minute
            if (timerStatus) {
                timerStatus.textContent = `${this.config.costPerMinute}💎/мин`;
                timerStatus.className = 'timer-paid';
            }

            // Check if we need to deduct for this minute
            const paidMinutes = totalMinutes - freeMinutes;
            const lastDeductedMinute = Math.floor((this.totalUsedTime + elapsed - 60) / 60) - freeMinutes;

            // Deduct at the start of each new paid minute
            if (paidMinutes > lastDeductedMinute && elapsed % 60 === 0) {
                const deducted = this.deductBalance(this.config.costPerMinute, 'call minute');
                if (!deducted) {
                    // Not enough balance - could end call or allow debt
                    this.showWarning('Недостаточно кристаллов для продолжения звонка!');
                }
            }
        }
    }

    // ===== FEATURES =====
    canAfford(amount) {
        return this.balance >= amount;
    }

    activateEncryption() {
        const cost = this.config.features.encryption.cost;

        if (this.encryptionPaid) {
            return true; // Already paid for this call
        }

        if (this.deductBalance(cost, 'encryption')) {
            this.encryptionPaid = true;
            this.showToast(`🔒 Шифрование активировано (-${cost}💎)`);
            return true;
        }

        return false;
    }

    activateTranscription() {
        const cost = this.config.features.transcription.cost;

        if (this.transcriptionPaid) {
            this.showToast('Транскрипция уже активирована');
            return true;
        }

        if (this.deductBalance(cost, 'transcription')) {
            this.transcriptionPaid = true;
            this.showToast(`📝 Транскрипция активирована (-${cost}💎)`);
            return true;
        }

        return false;
    }

    // ===== UTILS =====
    showToast(message) {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }
    }

    showWarning(message) {
        this.showToast(`⚠️ ${message}`);
    }

    // ===== STATS =====
    getStats() {
        return {
            balance: this.balance,
            totalUsedMinutes: Math.floor(this.totalUsedTime / 60),
            freeTimeRemaining: Math.max(0, this.config.freeTimeMinutes - Math.floor(this.totalUsedTime / 60))
        };
    }
}
