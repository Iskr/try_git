# 📞 Calling Service WebApp

Веб-приложение для звонков с поддержкой WebRTC, оптимизированное для Telegram WebView и native wrappers (iOS/Android).

## 🌟 Возможности

- ✅ Видео и аудио звонки через WebRTC (P2P)
- ✅ Быстрое создание звонков по ссылкам
- ✅ Оптимизирован для Telegram WebView
- ✅ Поддержка темной темы
- ✅ Адаптивный дизайн (mobile-first)
- ✅ Готов к обертке в native iOS/Android приложения
- ✅ Простая интеграция с Telegram ботом
- ✅ Шаринг через Telegram

## 🚀 Быстрый старт

### Установка зависимостей

```bash
npm install
```

### Запуск сервера

```bash
# Production
npm start

# Development (с авто-перезагрузкой)
npm run dev
```

Сервер запустится на `http://localhost:3000`

## 📦 Структура проекта

```
.
├── server.js           # WebSocket signaling server
├── package.json        # Зависимости
├── public/
│   ├── index.html     # Основной интерфейс
│   ├── app.js         # WebRTC логика
│   └── style.css      # Стили (mobile-first)
└── README.md
```

## 🔧 Технологии

- **Backend**: Node.js, Express, WebSocket (ws)
- **Frontend**: Vanilla JavaScript, WebRTC API
- **Стили**: CSS3 (Flexbox, CSS Variables)
- **Связь**: WebSocket для сигнализации, WebRTC для P2P звонков

## 🌐 Деплой

### Вариант 1: VPS/Облачный сервер

```bash
# Установите Node.js на сервере
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Склонируйте репозиторий
git clone <your-repo-url>
cd calling-service-webapp

# Установите зависимости
npm install

# Используйте PM2 для автозапуска
npm install -g pm2
pm2 start server.js
pm2 startup
pm2 save
```

### Вариант 2: Heroku

```bash
# Установите Heroku CLI
# https://devcenter.heroku.com/articles/heroku-cli

# Создайте приложение
heroku create your-app-name

# Деплой
git push heroku main

# Откройте приложение
heroku open
```

### Вариант 3: Railway.app

1. Создайте аккаунт на [Railway.app](https://railway.app)
2. Нажмите "New Project" → "Deploy from GitHub repo"
3. Выберите этот репозиторий
4. Railway автоматически развернет приложение

### Вариант 4: Vercel

```bash
# Установите Vercel CLI
npm i -g vercel

# Деплой
vercel
```

### Важно для production:

1. **HTTPS обязателен** - WebRTC требует HTTPS для доступа к камере/микрофону
2. **WebSocket** - Убедитесь, что ваш хостинг поддерживает WebSocket
3. **Порты** - Откройте порт 3000 (или настройте через `process.env.PORT`)

## 🤖 Интеграция с Telegram Bot

### Создание Telegram бота

1. Создайте бота через [@BotFather](https://t.me/botfather)
2. Получите токен бота
3. Создайте файл `telegram-bot.js`:

```javascript
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = 'YOUR_BOT_TOKEN';
const WEB_APP_URL = 'https://your-domain.com'; // URL вашего веб-приложения

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, 'Привет! Нажмите кнопку ниже для начала звонка:', {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '📞 Создать звонок',
          web_app: { url: WEB_APP_URL }
        }
      ]]
    }
  });
});

bot.onText(/\/call/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, 'Запуск звонка...', {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '📞 Открыть',
          web_app: { url: WEB_APP_URL }
        }
      ]]
    }
  });
});
```

4. Установите зависимости и запустите:

```bash
npm install node-telegram-bot-api
node telegram-bot.js
```

### Web App в Telegram

Telegram поддерживает Web Apps из коробки. Приложение уже оптимизировано:

- ✅ Адаптивный дизайн для Telegram WebView
- ✅ Поддержка темной темы Telegram
- ✅ Интеграция с Telegram.WebApp API для шаринга
- ✅ Оптимизация для мобильных устройств

## 📱 Native Wrappers (iOS/Android)

### iOS (Cordova)

```bash
# Установите Cordova
npm install -g cordova

# Создайте проект
cordova create CallingApp com.example.calling CallingApp
cd CallingApp

# Добавьте iOS платформу
cordova platform add ios

# Добавьте необходимые плагины
cordova plugin add cordova-plugin-device
cordova plugin add cordova-plugin-camera
cordova plugin add cordova-plugin-media
cordova plugin add cordova-plugin-inappbrowser

# Скопируйте файлы из public/ в www/
# Обновите config.xml с правами доступа

# Сборка
cordova build ios
```

### Android (Cordova)

```bash
# Добавьте Android платформу
cordova platform add android

# Сборка
cordova build android
```

### Capacitor (рекомендуется)

```bash
# Установите Capacitor
npm install @capacitor/core @capacitor/cli
npx cap init

# Добавьте платформы
npx cap add ios
npx cap add android

# Скопируйте веб-файлы
npx cap copy

# Откройте в Xcode/Android Studio
npx cap open ios
npx cap open android
```

### Требуемые разрешения

**iOS (Info.plist):**
```xml
<key>NSCameraUsageDescription</key>
<string>Требуется для видео звонков</string>
<key>NSMicrophoneUsageDescription</key>
<string>Требуется для аудио звонков</string>
```

**Android (AndroidManifest.xml):**
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.INTERNET" />
```

## 🔒 Безопасность

- WebRTC обеспечивает end-to-end encryption для медиа потоков
- Коды комнат генерируются случайным образом (6 символов)
- Рекомендуется добавить аутентификацию для production использования
- Используйте HTTPS в production

## 🎨 Кастомизация

### Изменение цветов

Отредактируйте CSS переменные в `public/style.css`:

```css
:root {
    --primary-color: #0088cc;  /* Основной цвет */
    --primary-hover: #006699;  /* Цвет при наведении */
    --danger-color: #dc3545;   /* Цвет завершения звонка */
}
```

### Добавление TURN серверов

Для работы через NAT/firewall добавьте TURN сервера в `public/app.js`:

```javascript
const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:your-turn-server.com:3478',
            username: 'username',
            credential: 'password'
        }
    ]
};
```

## 🐛 Отладка

### Проверка WebRTC соединения

Откройте Chrome DevTools → Console и проверьте:

```javascript
// Проверка доступа к медиа устройствам
navigator.mediaDevices.enumerateDevices()
  .then(devices => console.log(devices));

// Проверка WebRTC
console.log(RTCPeerConnection);
```

### Проблемы с доступом к камере/микрофону

1. Убедитесь, что используется HTTPS
2. Проверьте разрешения в браузере
3. Проверьте, не блокирует ли браузер доступ к медиа

### WebSocket не подключается

1. Проверьте, что сервер запущен
2. Проверьте порт (по умолчанию 3000)
3. Убедитесь, что WebSocket не блокируется firewall

## 📝 Лицензия

MIT

## 🤝 Вклад

Pull requests приветствуются!

## 📧 Поддержка

Если у вас возникли вопросы или проблемы, создайте issue в репозитории.

---

**Примечание**: Для работы в России убедитесь, что используете STUN/TURN серверы, доступные в вашем регионе, или разверните собственные.
