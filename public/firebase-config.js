// Firebase Configuration
// ВАЖНО: Замените эти значения на ваши реальные настройки Firebase
// Получите их в Firebase Console -> Project Settings -> General -> Your apps

const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Инструкция по настройке:
// 1. Зайдите в Firebase Console (https://console.firebase.google.com/)
// 2. Создайте новый проект или выберите существующий
// 3. Перейдите в Project Settings (⚙️ -> Project settings)
// 4. Прокрутите вниз до раздела "Your apps"
// 5. Нажмите на иконку "</>" (Web app)
// 6. Зарегистрируйте приложение и скопируйте конфигурацию сюда
// 7. В разделе Authentication включите Email/Password провайдер
