/* ============================================================================
   GeoMetric — ЯЗЫКИ ИНТЕРФЕЙСА
   ----------------------------------------------------------------------------
   Здесь лежат переводы всех надписей и маленький движок, который подставляет
   их на выбранном языке. Русский текст в разметке остаётся основным: если
   перевода нет — надпись просто останется русской, ничего не сломается.
   Подключение: файл i18n.js стоит в index.html ПЕРЕД app.js.
   ============================================================================ */

window.GM_LANGS = [                                                // языки, которые видит человек в настройках
  { code: "ru", title: "Русский" },                                // русский (основной)
  { code: "en", title: "English" },                                // английский
  { code: "de", title: "Deutsch" },                                // немецкий
  { code: "es", title: "Español" }                                 // испанский
];

window.gmLang = window.gmLang || "ru";                             // выбранный язык (по умолчанию — русский)

window.GM_I18N = {                                                 // словарь: русская надпись → переводы
  "Вход": { en: "Sign in", de: "Anmelden", es: "Iniciar sesión" },   // Вход
  "Регистрация": { en: "Sign up", de: "Registrierung", es: "Registro" },   // Регистрация
  "Как вас зовут": { en: "Your name", de: "Ihr Name", es: "Su nombre" },   // Как вас зовут
  "Логин": { en: "Login", de: "Login", es: "Usuario" },   // Логин
  "Пароль": { en: "Password", de: "Passwort", es: "Contraseña" },   // Пароль
  "Повторите пароль": { en: "Repeat password", de: "Passwort wiederholen", es: "Repita la contraseña" },   // Повторите пароль
  "Войти": { en: "Sign in", de: "Anmelden", es: "Entrar" },   // Войти
  "Создать аккаунт": { en: "Create account", de: "Konto erstellen", es: "Crear cuenta" },   // Создать аккаунт
  "Разблокировать переписку": { en: "Unlock chats", de: "Chats entsperren", es: "Desbloquear chats" },   // Разблокировать переписку
  "Введите пароль, чтобы открыть переписку на этом устройстве.": { en: "Enter your password to open your chats on this device.", de: "Geben Sie Ihr Passwort ein, um die Chats auf diesem Gerät zu öffnen.", es: "Introduzca su contraseña para abrir los chats en este dispositivo." },   // Введите пароль, чтобы открыть переписку на этом устройстве.
  "Запомнить на этом устройстве (быстрее вход, но менее безопасно)": { en: "Remember on this device (faster sign-in, less secure)", de: "Auf diesem Gerät merken (schneller, aber weniger sicher)", es: "Recordar en este dispositivo (más rápido, menos seguro)" },   // Запомнить на этом устройстве (быстрее вход, но менее безопасно)
  "Разблокировать": { en: "Unlock", de: "Entsperren", es: "Desbloquear" },   // Разблокировать
  "Общайтесь так,": { en: "Chat in a way that", de: "Kommunizieren Sie so,", es: "Comuníquese de modo que" },   // Общайтесь так,
  "чтобы это осталось": { en: "that stays", de: "damit es", es: "que quede" },   // чтобы это осталось
  "только вашим": { en: "yours only", de: "nur Ihnen gehört", es: "solo para usted" },   // только вашим
  "Свои стикеры и боты": { en: "Your own stickers and bots", de: "Eigene Sticker und Bots", es: "Sus propios stickers y bots" },   // Свои стикеры и боты
  "Собирайте наборы стикеров и запускайте ботов на Python": { en: "Build sticker sets and run Python bots", de: "Sticker-Sets erstellen und Python-Bots starten", es: "Cree sets de stickers y ejecute bots en Python" },   // Собирайте наборы стикеров и запускайте ботов на Python
  "Звонки и видеозвонки": { en: "Calls and video calls", de: "Anrufe und Videoanrufe", es: "Llamadas y videollamadas" },   // Звонки и видеозвонки
  "Звук идёт напрямую между устройствами (P2P)": { en: "Sound goes directly between devices (P2P)", de: "Der Ton läuft direkt zwischen den Geräten (P2P)", es: "El sonido va directo entre dispositivos (P2P)" },   // Звук идёт напрямую между устройствами (P2P)
  "Истории на 24 часа": { en: "Stories for 24 hours", de: "Storys für 24 Stunden", es: "Historias por 24 horas" },   // Истории на 24 часа
  "С настройкой «видно всем» или «только контактам»": { en: "With “everyone” or “contacts only” visibility", de: "Mit Sichtbarkeit „für alle“ oder „nur Kontakte“", es: "Con visibilidad «para todos» o «solo contactos»" },   // С настройкой «видно всем» или «только контактам»
  "Приватность под контролем": { en: "Privacy under your control", de: "Privatsphäre unter Ihrer Kontrolle", es: "Privacidad bajo su control" },   // Приватность под контролем
  "Можно скрыть статус «в сети» и время последнего визита": { en: "You can hide your online status and last visit time", de: "Sie können Online-Status und letzte Anwesenheit verbergen", es: "Puede ocultar el estado «en línea» y la última visita" },   // Можно скрыть статус «в сети» и время последнего визита
  "Подключаюсь к серверу…": { en: "Connecting to the server…", de: "Verbindung zum Server…", es: "Conectando con el servidor…" },   // Подключаюсь к серверу…
  "Выберите чат": { en: "Select a chat", de: "Wählen Sie einen Chat", es: "Elija un chat" },   // Выберите чат
  "Или найдите собеседника по логину и начните переписку.": { en: "Or find someone by login and start chatting.", de: "Oder suchen Sie jemanden per Login und starten Sie den Chat.", es: "O busque a alguien por su usuario y empiece a chatear." },   // Или найдите собеседника по логину и начните переписку.
  "Найти собеседника": { en: "Find someone", de: "Person finden", es: "Buscar a alguien" },   // Найти собеседника
  "Писать могут только администраторы канала": { en: "Only channel admins can post", de: "Nur Kanal-Administratoren können schreiben", es: "Solo los administradores del canal pueden escribir" },   // Писать могут только администраторы канала
  "Чаты": { en: "Chats", de: "Chats", es: "Chats" },   // Чаты
  "Контакты": { en: "Contacts", de: "Kontakte", es: "Contactos" },   // Контакты
  "Профиль": { en: "Profile", de: "Profil", es: "Perfil" },   // Профиль
  "Настройки": { en: "Settings", de: "Einstellungen", es: "Ajustes" },   // Настройки
  "Новая группа": { en: "New group", de: "Neue Gruppe", es: "Nuevo grupo" },   // Новая группа
  "Найти канал": { en: "Find a channel", de: "Kanal finden", es: "Buscar un canal" },   // Найти канал
  "Избранное": { en: "Saved messages", de: "Gespeicherte Nachrichten", es: "Mensajes guardados" },   // Избранное
  "Новая история": { en: "New story", de: "Neue Story", es: "Nueva historia" },   // Новая история
  "Эмодзи": { en: "Emoji", de: "Emoji", es: "Emoji" },   // Эмодзи
  "Новый набор": { en: "New set", de: "Neues Set", es: "Nuevo set" },   // Новый набор
  "Стикер-бот": { en: "Sticker bot", de: "Sticker-Bot", es: "Bot de stickers" },   // Стикер-бот
  "Мои наборы": { en: "My sets", de: "Meine Sets", es: "Mis sets" },   // Мои наборы
  "Идёт запись…": { en: "Recording…", de: "Aufnahme…", es: "Grabando…" },   // Идёт запись…
  "Отправить": { en: "Send", de: "Senden", es: "Enviar" },   // Отправить
  "Отмена": { en: "Cancel", de: "Abbrechen", es: "Cancelar" },   // Отмена
  "отпустите, чтобы отправить": { en: "release to send", de: "loslassen zum Senden", es: "suelte para enviar" },   // отпустите, чтобы отправить
  "Чат": { en: "Chat", de: "Chat", es: "Chat" },   // Чат
  "Поиск в переписке": { en: "Search in chat", de: "Im Chat suchen", es: "Buscar en el chat" },   // Поиск в переписке
  "Изменить обои": { en: "Change wallpaper", de: "Hintergrund ändern", es: "Cambiar fondo" },   // Изменить обои
  "Выключить уведомления": { en: "Mute notifications", de: "Benachrichtigungen stumm", es: "Silenciar notificaciones" },   // Выключить уведомления
  "Включить уведомления": { en: "Unmute notifications", de: "Benachrichtigungen aktivieren", es: "Activar notificaciones" },   // Включить уведомления
  "Секретный чат": { en: "Secret chat", de: "Geheimer Chat", es: "Chat secreto" },   // Секретный чат
  "Ярлык на телефоне": { en: "Phone shortcut", de: "Verknüpfung auf dem Handy", es: "Acceso directo en el teléfono" },   // Ярлык на телефоне
  "Пожаловаться": { en: "Report", de: "Melden", es: "Denunciar" },   // Пожаловаться
  "Заблокировать": { en: "Block", de: "Blockieren", es: "Bloquear" },   // Заблокировать
  "Очистить историю": { en: "Clear history", de: "Verlauf löschen", es: "Borrar historial" },   // Очистить историю
  "Удалить чат": { en: "Delete chat", de: "Chat löschen", es: "Eliminar chat" },   // Удалить чат
  "Обои чата": { en: "Chat wallpaper", de: "Chat-Hintergrund", es: "Fondo del chat" },   // Обои чата
  "Своя картинка": { en: "Your picture", de: "Eigenes Bild", es: "Imagen propia" },   // Своя картинка
  "Убрать обои": { en: "Remove wallpaper", de: "Hintergrund entfernen", es: "Quitar fondo" },   // Убрать обои
  "Только у меня": { en: "Only for me", de: "Nur für mich", es: "Solo para mí" },   // Только у меня
  "У обоих": { en: "For both", de: "Für beide", es: "Para ambos" },   // У обоих
  "Новый чат": { en: "New chat", de: "Neuer Chat", es: "Nuevo chat" },   // Новый чат
  "Новый канал": { en: "New channel", de: "Neuer Kanal", es: "Nuevo canal" },   // Новый канал
  "Нажмите, чтобы выбрать фото или видео": { en: "Tap to choose a photo or video", de: "Tippen, um Foto oder Video zu wählen", es: "Toque para elegir foto o vídeo" },   // Нажмите, чтобы выбрать фото или видео
  "Кто увидит:": { en: "Who can see:", de: "Wer sieht es:", es: "Quién lo verá:" },   // Кто увидит:
  "Опубликовать на 24 часа": { en: "Publish for 24 hours", de: "Für 24 Stunden veröffentlichen", es: "Publicar por 24 horas" },   // Опубликовать на 24 часа
  "Изменить логин": { en: "Change login", de: "Login ändern", es: "Cambiar usuario" },   // Изменить логин
  "Копировать": { en: "Copy", de: "Kopieren", es: "Copiar" },   // Копировать
  "Копировать текст": { en: "Copy text", de: "Text kopieren", es: "Copiar texto" },   // Копировать текст
  "О себе": { en: "About", de: "Über mich", es: "Sobre mí" },   // О себе
  "День рождения": { en: "Birthday", de: "Geburtstag", es: "Cumpleaños" },   // День рождения
  "Закреплённый канал": { en: "Pinned channel", de: "Angehefteter Kanal", es: "Canal fijado" },   // Закреплённый канал
  "Не закреплять": { en: "Do not pin", de: "Nicht anheften", es: "No fijar" },   // Не закреплять
  "Смена пароля": { en: "Change password", de: "Passwort ändern", es: "Cambiar contraseña" },   // Смена пароля
  "Сменить пароль": { en: "Change password", de: "Passwort ändern", es: "Cambiar contraseña" },   // Сменить пароль
  "После смены пароля потребуется войти заново на других устройствах.": { en: "After changing your password you will need to sign in again on other devices.", de: "Nach dem Passwortwechsel müssen Sie sich auf anderen Geräten neu anmelden.", es: "Tras cambiar la contraseña deberá iniciar sesión de nuevo en otros dispositivos." },   // После смены пароля потребуется войти заново на других устройствах.
  "Позвонить": { en: "Call", de: "Anrufen", es: "Llamar" },   // Позвонить
  "Оформление": { en: "Appearance", de: "Aussehen", es: "Apariencia" },   // Оформление
  "Тёмная": { en: "Dark", de: "Dunkel", es: "Oscuro" },   // Тёмная
  "Светлая": { en: "Light", de: "Hell", es: "Claro" },   // Светлая
  "Синяя": { en: "Blue", de: "Blau", es: "Azul" },   // Синяя
  "Изумрудная": { en: "Emerald", de: "Smaragd", es: "Esmeralda" },   // Изумрудная
  "Морская": { en: "Ocean", de: "Ozean", es: "Océano" },   // Морская
  "Розовая": { en: "Pink", de: "Rosa", es: "Rosa" },   // Розовая
  "Закат": { en: "Sunset", de: "Sonnenuntergang", es: "Atardecer" },   // Закат
  "Кофейная": { en: "Coffee", de: "Kaffee", es: "Café" },   // Кофейная
  "Графитовая": { en: "Graphite", de: "Graphit", es: "Grafito" },   // Графитовая
  "Лаванда": { en: "Lavender", de: "Lavendel", es: "Lavanda" },   // Лаванда
  "Мятная": { en: "Mint", de: "Minze", es: "Menta" },   // Мятная
  "Компактный список чатов": { en: "Compact chat list", de: "Kompakte Chat-Liste", es: "Lista de chats compacta" },   // Компактный список чатов
  "Сообщения": { en: "Messages", de: "Nachrichten", es: "Mensajes" },   // Сообщения
  "Отправлять по Enter": { en: "Send with Enter", de: "Mit Enter senden", es: "Enviar con Enter" },   // Отправлять по Enter
  "Отправлять галочки «прочитано»": { en: "Send read receipts", de: "Lesebestätigungen senden", es: "Enviar confirmaciones de lectura" },   // Отправлять галочки «прочитано»
  "Звуки сообщений и звонков": { en: "Message and call sounds", de: "Nachrichten- und Anruftöne", es: "Sonidos de mensajes y llamadas" },   // Звуки сообщений и звонков
  "Уведомления на рабочем столе": { en: "Desktop notifications", de: "Desktop-Benachrichtigungen", es: "Notificaciones en el escritorio" },   // Уведомления на рабочем столе
  "Приватность": { en: "Privacy", de: "Privatsphäre", es: "Privacidad" },   // Приватность
  "Скрыть статус «в сети»": { en: "Hide online status", de: "Online-Status verbergen", es: "Ocultar estado «en línea»" },   // Скрыть статус «в сети»
  "Скрыть «был(а) недавно»": { en: "Hide last seen", de: "Letzte Anwesenheit verbergen", es: "Ocultar «última vez»" },   // Скрыть «был(а) недавно»
  "Кто видит мои истории": { en: "Who can see my stories", de: "Wer sieht meine Storys", es: "Quién ve mis historias" },   // Кто видит мои истории
  "Показ фото в истории": { en: "Photo duration in stories", de: "Anzeigedauer der Fotos", es: "Duración de las fotos" },   // Показ фото в истории
  "3 секунды": { en: "3 seconds", de: "3 Sekunden", es: "3 segundos" },   // 3 секунды
  "5 секунд": { en: "5 seconds", de: "5 Sekunden", es: "5 segundos" },   // 5 секунд
  "8 секунд": { en: "8 seconds", de: "8 Sekunden", es: "8 segundos" },   // 8 секунд
  "10 секунд": { en: "10 seconds", de: "10 Sekunden", es: "10 segundos" },   // 10 секунд
  "Приложение": { en: "App", de: "App", es: "Aplicación" },   // Приложение
  "Режим": { en: "Mode", de: "Modus", es: "Modo" },   // Режим
  "Установить приложение": { en: "Install app", de: "App installieren", es: "Instalar aplicación" },   // Установить приложение
  "Очистить кэш и данные": { en: "Clear cache and data", de: "Cache und Daten löschen", es: "Borrar caché y datos" },   // Очистить кэш и данные
  "Настройки хранятся на этом устройстве и синхронизируются с вашим профилем.": { en: "Settings are kept on this device and synced with your profile.", de: "Einstellungen bleiben auf diesem Gerät und werden mit Ihrem Profil synchronisiert.", es: "Los ajustes se guardan en este dispositivo y se sincronizan con su perfil." },   // Настройки хранятся на этом устройстве и синхронизируются с вашим профилем.
  "Устройства": { en: "Devices", de: "Geräte", es: "Dispositivos" },   // Устройства
  "Боты": { en: "Bots", de: "Bots", es: "Bots" },   // Боты
  "Создать бота": { en: "Create bot", de: "Bot erstellen", es: "Crear bot" },   // Создать бота
  "Стикеры": { en: "Stickers", de: "Sticker", es: "Stickers" },   // Стикеры
  "Создать набор из картинок": { en: "Create a set from pictures", de: "Set aus Bildern erstellen", es: "Crear set con imágenes" },   // Создать набор из картинок
  "Звонок…": { en: "Calling…", de: "Anruf…", es: "Llamada…" },   // Звонок…
  "Соединение напрямую между устройствами": { en: "Direct connection between devices", de: "Direkte Verbindung zwischen Geräten", es: "Conexión directa entre dispositivos" },   // Соединение напрямую между устройствами
  "Ответить": { en: "Reply", de: "Antworten", es: "Responder" },   // Ответить
  "Удалить у всех": { en: "Delete for everyone", de: "Für alle löschen", es: "Eliminar para todos" },   // Удалить у всех
  "Удалить у меня": { en: "Delete for me", de: "Nur für mich löschen", es: "Eliminar para mí" },   // Удалить у меня
  "Своя вкладка": { en: "Your tab", de: "Eigener Tab", es: "Su pestaña" },   // Своя вкладка
  "Что показывать": { en: "What to show", de: "Was anzeigen", es: "Qué mostrar" },   // Что показывать
  "Личные переписки": { en: "Personal chats", de: "Persönliche Chats", es: "Chats personales" },   // Личные переписки
  "Добавить вкладку": { en: "Add tab", de: "Tab hinzufügen", es: "Añadir pestaña" },   // Добавить вкладку
  "Описание": { en: "Description", de: "Beschreibung", es: "Descripción" },   // Описание
  "Цвет": { en: "Color", de: "Farbe", es: "Color" },   // Цвет
  "Кого пригласить": { en: "Who to invite", de: "A Wen einladen", es: "A quién invitar" },   // Кого пригласить
  "В группу и канал можно приглашать людей по логину сразу при создании.": { en: "You can invite people by login right when creating a group or channel.", de: "Beim Erstellen einer Gruppe oder eines Kanals können Sie Personen per Login einladen.", es: "Puede invitar a personas por su usuario al crear un grupo o canal." },   // В группу и канал можно приглашать людей по логину сразу при создании.
  "Создать": { en: "Create", de: "Erstellen", es: "Crear" },   // Создать
  "Участники": { en: "Members", de: "Mitglieder", es: "Miembros" },   // Участники
  "Выйти из комнаты": { en: "Leave the room", de: "Raum verlassen", es: "Salir de la sala" },   // Выйти из комнаты
  "Найти канал или группу": { en: "Find a channel or group", de: "Kanal oder Gruppe finden", es: "Buscar canal o grupo" },   // Найти канал или группу
  "Ищем среди открытых комнат вашего сервера.": { en: "Searching open rooms on your server.", de: "Suche in offenen Räumen Ihres Servers.", es: "Buscando en las salas abiertas de su servidor." },   // Ищем среди открытых комнат вашего сервера.
  "Например, Анна": { en: "e.g. Anna", de: "z. B. Anna", es: "Por ejemplo, Ana" },   // Например, Анна
  "латиница и цифры": { en: "latin letters and digits", de: "lateinische Buchstaben und Ziffern", es: "letras latinas y números" },   // латиница и цифры
  "минимум 6 символов": { en: "at least 6 characters", de: "mindestens 6 Zeichen", es: "mínimo 6 caracteres" },   // минимум 6 символов
  "ещё раз": { en: "again", de: "noch einmal", es: "otra vez" },   // ещё раз
  "Поиск по чатам": { en: "Search chats", de: "Chats suchen", es: "Buscar en chats" },   // Поиск по чатам
  "Назад": { en: "Back", de: "Zurück", es: "Atrás" },   // Назад
  "Информация о собеседнике": { en: "Contact info", de: "Infos zum Kontakt", es: "Información del contacto" },   // Информация о собеседнике
  "Аудиозвонок": { en: "Voice call", de: "Sprachanruf", es: "Llamada de voz" },   // Аудиозвонок
  "Ещё": { en: "More", de: "Mehr", es: "Más" },   // Ещё
  "Найти в переписке": { en: "Search in chat", de: "Im Chat suchen", es: "Buscar en el chat" },   // Найти в переписке
  "Закрыть поиск": { en: "Close search", de: "Suche schließen", es: "Cerrar búsqueda" },   // Закрыть поиск
  "Стикеры и эмодзи": { en: "Stickers and emoji", de: "Sticker und Emoji", es: "Stickers y emoji" },   // Стикеры и эмодзи
  "Прикрепить файл": { en: "Attach file", de: "Datei anhängen", es: "Adjuntar archivo" },   // Прикрепить файл
  "Голосовое: зажать и провести вверх": { en: "Voice: hold and slide up", de: "Sprachnachricht: halten und nach oben ziehen", es: "Voz: mantenga y deslice hacia arriba" },   // Голосовое: зажать и провести вверх
  "Видеокружок: нажмите — начнётся запись, нажмите ещё раз — отправить": { en: "Video circle: tap to start recording, tap again to send", de: "Video-Kreis: tippen zum Aufnehmen, erneut tippen zum Senden", es: "Círculo de vídeo: toque para grabar, toque otra vez para enviar" },   // Видеокружок: нажмите — начнётся запись, нажмите ещё раз — отправить
  "Найти человека по логину": { en: "Find a person by login", de: "Person per Login finden", es: "Buscar a alguien por su usuario" },   // Найти человека по логину
  "Логин или имя (минимум 2 символа)": { en: "Login or name (at least 2 characters)", de: "Login oder Name (mindestens 2 Zeichen)", es: "Usuario o nombre (mínimo 2 caracteres)" },   // Логин или имя (минимум 2 символа)
  "Подпись (необязательно)": { en: "Caption (optional)", de: "Beschriftung (optional)", es: "Texto (opcional)" },   // Подпись (необязательно)
  "Ваше имя": { en: "Your name", de: "Ihr Name", es: "Su nombre" },   // Ваше имя
  "Новый логин": { en: "New login", de: "Neuer Login", es: "Nuevo usuario" },   // Новый логин
  "Пара слов о себе": { en: "A few words about you", de: "Ein paar Worte über Sie", es: "Unas palabras sobre usted" },   // Пара слов о себе
  "Текущий пароль": { en: "Current password", de: "Aktuelles Passwort", es: "Contraseña actual" },   // Текущий пароль
  "Новый пароль (минимум 6 символов)": { en: "New password (at least 6 characters)", de: "Neues Passwort (mindestens 6 Zeichen)", es: "Nueva contraseña (mínimo 6 caracteres)" },   // Новый пароль (минимум 6 символов)
  "Повторите новый пароль": { en: "Repeat the new password", de: "Neues Passwort wiederholen", es: "Repita la nueva contraseña" },   // Повторите новый пароль
  "Логин бота (латиница и цифры)": { en: "Bot login (latin letters and digits)", de: "Bot-Login (lateinische Buchstaben und Ziffern)", es: "Usuario del bot (letras latinas y números)" },   // Логин бота (латиница и цифры)
  "Название (например, Погода)": { en: "Name (e.g. Weather)", de: "Name (z. B. Wetter)", es: "Nombre (por ejemplo, Clima)" },   // Название (например, Погода)
  "Что умеет (необязательно)": { en: "What it can do (optional)", de: "Was er kann (optional)", es: "Qué sabe hacer (opcional)" },   // Что умеет (необязательно)
  "Микрофон": { en: "Microphone", de: "Mikrofon", es: "Micrófono" },   // Микрофон
  "Камера": { en: "Camera", de: "Kamera", es: "Cámara" },   // Камера
  "Принять": { en: "Accept", de: "Annehmen", es: "Aceptar" },   // Принять
  "Например, Работа": { en: "e.g. Work", de: "z. B. Arbeit", es: "Por ejemplo, Trabajo" },   // Например, Работа
  "Например, Друзья": { en: "e.g. Friends", de: "z. B. Freunde", es: "Por ejemplo, Amigos" },   // Например, Друзья
  "О чём эта группа": { en: "What is this group about", de: "Worum geht es in dieser Gruppe", es: "De qué trata este grupo" },   // О чём эта группа
  "Сегодня": { en: "Today", de: "Heute", es: "Hoy" },   // Сегодня
  "Вчера": { en: "Yesterday", de: "Gestern", es: "Ayer" },   // Вчера
  "недавно": { en: "recently", de: "kürzlich", es: "recientemente" },   // недавно
  "только что": { en: "just now", de: "gerade eben", es: "ahora mismo" },   // только что
  "Название": { en: "Name", de: "Name", es: "Nombre" },   // Название
  "Сохранить": { en: "Save", de: "Speichern", es: "Guardar" },   // Сохранить
  "@адрес": { en: "@login", de: "@Login", es: "@usuario" },   // @адрес
  "Выйти из аккаунта": { en: "Sign out", de: "Abmelden", es: "Cerrar sesión" },   // Выйти из аккаунта
  "Все": { en: "Everyone", de: "Alle", es: "Todos" },   // Все
  "Только контакты": { en: "Contacts only", de: "Nur Kontakte", es: "Solo contactos" },   // Только контакты
  "Медиа": { en: "Media", de: "Medien", es: "Multimedia" },   // Медиа
  "Видео": { en: "Video", de: "Video", es: "Vídeo" },   // Видео
  "Разговор": { en: "Conversation", de: "Gespräch", es: "Conversación" },   // Разговор
  "Удалить": { en: "Delete", de: "Löschen", es: "Eliminar" },   // Удалить
  "Группы": { en: "Groups", de: "Gruppen", es: "Grupos" },   // Группы
  "Каналы": { en: "Channels", de: "Kanäle", es: "Canales" },   // Каналы
  "Непрочитанные": { en: "Unread", de: "Ungelesen", es: "Sin leer" },   // Непрочитанные
  "Все чаты": { en: "All chats", de: "Alle Chats", es: "Todos los chats" },   // Все чаты
  "Группа": { en: "Group", de: "Gruppe", es: "Grupo" },   // Группа
  "Без описания": { en: "No description", de: "Keine Beschreibung", es: "Sin descripción" },   // Без описания
  "Свернуть": { en: "Minimize", de: "Minimieren", es: "Minimizar" },   // Свернуть
  "Развернуть": { en: "Maximize", de: "Maximieren", es: "Maximizar" },   // Развернуть
  "Вернуть прежний размер": { en: "Restore the previous size", de: "Vorherige Größe wiederherstellen", es: "Restaurar el tamaño anterior" },   // Вернуть прежний размер
  "Завершить": { en: "End", de: "Beenden", es: "Finalizar" },   // Завершить
  "статус скрыт": { en: "status hidden", de: "Status verborgen", es: "estado oculto" },   // статус скрыт
  "в сети": { en: "online", de: "online", es: "en línea" },   // в сети
  "не в сети": { en: "offline", de: "offline", es: "sin conexión" },   // не в сети
  "Исходящий звонок": { en: "Outgoing call", de: "Ausgehender Anruf", es: "Llamada saliente" },   // Исходящий звонок
  "Входящий звонок": { en: "Incoming call", de: "Eingehender Anruf", es: "Llamada entrante" },   // Входящий звонок
  "Отклонённый звонок": { en: "Declined call", de: "Abgelehnter Anruf", es: "Llamada rechazada" },   // Отклонённый звонок
  "Пропущенный звонок": { en: "Missed call", de: "Verpasster Anruf", es: "Llamada perdida" },   // Пропущенный звонок
  "Отменённый звонок": { en: "Canceled call", de: "Stornierter Anruf", es: "Llamada cancelada" },   // Отменённый звонок
  "Нет ответа": { en: "No answer", de: "Keine Antwort", es: "Sin respuesta" },   // Нет ответа
  "Занято": { en: "Busy", de: "Besetzt", es: "Ocupado" },   // Занято
  "Звонок": { en: "Call", de: "Anruf", es: "Llamada" },   // Звонок
  "Звонок завершён": { en: "Call ended", de: "Anruf beendet", es: "Llamada finalizada" },   // Звонок завершён
  "Звонок отклонён": { en: "Call declined", de: "Anruf abgelehnt", es: "Llamada rechazada" },   // Звонок отклонён
  "Прочитано": { en: "Read", de: "Gelesen", es: "Leído" },   // Прочитано
  "Доставлено": { en: "Delivered", de: "Zugestellt", es: "Entregado" },   // Доставлено
  "Вы": { en: "You", de: "Sie", es: "Usted" },   // Вы
  "(вы)": { en: "(you)", de: "(Sie)", es: "(usted)" },   // (вы)
  "был(а)": { en: "last seen", de: "zuletzt", es: "última vez" },   // был(а)
  "Соединение…": { en: "Connecting…", de: "Verbindung…", es: "Conectando…" },   // Соединение…
  "Соединение потеряно": { en: "Connection lost", de: "Verbindung verloren", es: "Conexión perdida" },   // Соединение потеряно
  "Соединение напрямую": { en: "Direct connection", de: "Direkte Verbindung", es: "Conexión directa" },   // Соединение напрямую
  "Видеозвонок…": { en: "Video call…", de: "Videoanruf…", es: "Videollamada…" },   // Видеозвонок…
  "Звоним…": { en: "Calling…", de: "Rufe an…", es: "Llamando…" },   // Звоним…
  "Не отвечают": { en: "No answer", de: "Keine Antwort", es: "No responden" },   // Не отвечают
  "Устройство": { en: "Device", de: "Gerät", es: "Dispositivo" },   // Устройство
  "Телефон": { en: "Phone", de: "Telefon", es: "Teléfono" },   // Телефон
  "Компьютер": { en: "Computer", de: "Computer", es: "Computadora" },   // Компьютер
  "Настольное приложение": { en: "Desktop app", de: "Desktop-App", es: "Aplicación de escritorio" },   // Настольное приложение
  "Установленное приложение": { en: "Installed app", de: "Installierte App", es: "Aplicación instalada" },   // Установленное приложение
  "Браузер": { en: "Browser", de: "Browser", es: "Navegador" },   // Браузер
  "Медиафайл": { en: "Media file", de: "Mediendatei", es: "Archivo multimedia" },   // Медиафайл
  "Файл": { en: "File", de: "Datei", es: "Archivo" },   // Файл
  "Музыка": { en: "Music", de: "Musik", es: "Música" },   // Музыка
  "Аудио": { en: "Audio", de: "Audio", es: "Audio" },   // Аудио
  "Прослушать": { en: "Listen", de: "Anhören", es: "Escuchar" },   // Прослушать
  "Слушать": { en: "Play", de: "Abspielen", es: "Reproducir" },   // Слушать
  "Токен:": { en: "Token:", de: "Token:", es: "Token:" },   // Токен:
  "Мой": { en: "Mine", de: "Meins", es: "Mío" },   // Мой
  "Мой набор": { en: "My set", de: "Mein Set", es: "Mi set" },   // Мой набор
  "Набор": { en: "Set", de: "Set", es: "Set" },   // Набор
  "Название набора": { en: "Set name", de: "Name des Sets", es: "Nombre del set" },   // Название набора
  "Ошибка": { en: "Error", de: "Fehler", es: "Error" },   // Ошибка
  "Не удалось войти": { en: "Could not sign in", de: "Anmeldung fehlgeschlagen", es: "No se pudo iniciar sesión" },   // Не удалось войти
  "Не удалось зарегистрироваться": { en: "Could not sign up", de: "Registrierung fehlgeschlagen", es: "No se pudo registrar" },   // Не удалось зарегистрироваться
  "Неверный пароль": { en: "Wrong password", de: "Falsches Passwort", es: "Contraseña incorrecta" },   // Неверный пароль
  "Пароли не совпадают": { en: "Passwords do not match", de: "Passwörter stimmen nicht überein", es: "Las contraseñas no coinciden" },   // Пароли не совпадают
  "Пароль: минимум 6 символов": { en: "Password: at least 6 characters", de: "Passwort: mindestens 6 Zeichen", es: "Contraseña: mínimo 6 caracteres" },   // Пароль: минимум 6 символов
  "Логин: минимум 3 символа": { en: "Login: at least 3 characters", de: "Login: mindestens 3 Zeichen", es: "Usuario: mínimo 3 caracteres" },   // Логин: минимум 3 символа
  "Логин бота — минимум 3 символа": { en: "Bot login: at least 3 characters", de: "Bot-Login: mindestens 3 Zeichen", es: "Usuario del bot: mínimo 3 caracteres" },   // Логин бота — минимум 3 символа
  "Это ваш текущий логин": { en: "This is your current login", de: "Das ist Ihr aktuelles Login", es: "Este es su usuario actual" },   // Это ваш текущий логин
  "Сначала выберите фото или видео": { en: "Choose a photo or video first", de: "Wählen Sie zuerst ein Foto oder Video", es: "Elija primero una foto o un vídeo" },   // Сначала выберите фото или видео
  "Сначала откройте чат": { en: "Open a chat first", de: "Öffnen Sie zuerst einen Chat", es: "Abra primero un chat" },   // Сначала откройте чат
  "Введите название": { en: "Enter a name", de: "Geben Sie einen Namen ein", es: "Introduzca un nombre" },   // Введите название
  "Введите название вкладки": { en: "Enter a tab name", de: "Geben Sie einen Tab-Namen ein", es: "Introduzca un nombre de pestaña" },   // Введите название вкладки
  "Нечего копировать": { en: "Nothing to copy", de: "Nichts zu kopieren", es: "No hay nada que copiar" },   // Нечего копировать
  "Текст сообщения скопирован": { en: "Message text copied", de: "Nachrichtentext kopiert", es: "Texto del mensaje copiado" },   // Текст сообщения скопирован
  "Скопировать не удалось": { en: "Could not copy", de: "Kopieren fehlgeschlagen", es: "No se pudo copiar" },   // Скопировать не удалось
  "Сообщение недоступно": { en: "Message unavailable", de: "Nachricht nicht verfügbar", es: "Mensaje no disponible" },   // Сообщение недоступно
  "Ваши заметки и файлы — видно только вам": { en: "Your notes and files — visible only to you", de: "Ihre Notizen und Dateien — nur für Sie sichtbar", es: "Sus notas y archivos, solo visibles para usted" },   // Ваши заметки и файлы — видно только вам
  "Удалено у всех": { en: "Deleted for everyone", de: "Für alle gelöscht", es: "Eliminado para todos" },   // Удалено у всех
  "Удалено у вас": { en: "Deleted for you", de: "Für Sie gelöscht", es: "Eliminado para usted" },   // Удалено у вас
  "На этой вкладке пока пусто": { en: "This tab is empty for now", de: "Dieser Tab ist noch leer", es: "Esta pestaña está vacía por ahora" },   // На этой вкладке пока пусто
  "Файл будет отправлен как есть": { en: "The file will be sent as is", de: "Die Datei wird unverändert gesendet", es: "El archivo se enviará tal cual" },   // Файл будет отправлен как есть
  "Загружаю файл…": { en: "Uploading file…", de: "Datei wird hochgeladen…", es: "Subiendo archivo…" },   // Загружаю файл…
  "Файл готов к отправке": { en: "File is ready to send", de: "Datei ist sendebereit", es: "Archivo listo para enviar" },   // Файл готов к отправке
  "Ошибка загрузки": { en: "Upload error", de: "Upload-Fehler", es: "Error de carga" },   // Ошибка загрузки
  "Загружаю…": { en: "Loading…", de: "Lade…", es: "Cargando…" },   // Загружаю…
  "Открываю файл…": { en: "Opening file…", de: "Datei wird geöffnet…", es: "Abriendo archivo…" },   // Открываю файл…
  "Файл открыт:": { en: "File opened:", de: "Datei geöffnet:", es: "Archivo abierto:" },   // Файл открыт:
  "Открываю файл:": { en: "Opening file:", de: "Öffne Datei:", es: "Abriendo archivo:" },   // Открываю файл:
  "Не удалось открыть файл": { en: "Could not open the file", de: "Datei konnte nicht geöffnet werden", es: "No se pudo abrir el archivo" },   // Не удалось открыть файл
  "Не удалось загрузить файл": { en: "Could not upload the file", de: "Datei konnte nicht hochgeladen werden", es: "No se pudo subir el archivo" },   // Не удалось загрузить файл
  "Не удалось отправить файл": { en: "Could not send the file", de: "Datei konnte nicht gesendet werden", es: "No se pudo enviar el archivo" },   // Не удалось отправить файл
  "Не удалось воспроизвести": { en: "Could not play", de: "Wiedergabe fehlgeschlagen", es: "No se pudo reproducir" },   // Не удалось воспроизвести
  "Не удалось открыть музыку": { en: "Could not open the audio", de: "Audio konnte nicht geöffnet werden", es: "No se pudo abrir el audio" },   // Не удалось открыть музыку
  "Не удалось открыть кружок": { en: "Could not open the video circle", de: "Video-Kreis konnte nicht geöffnet werden", es: "No se pudo abrir el círculo" },   // Не удалось открыть кружок
  "Не удалось загрузить картинку": { en: "Could not load the image", de: "Bild konnte nicht geladen werden", es: "No se pudo cargar la imagen" },   // Не удалось загрузить картинку
  "Не удалось загрузить картинки": { en: "Could not load images", de: "Bilder konnten nicht geladen werden", es: "No se pudieron cargar las imágenes" },   // Не удалось загрузить картинки
  "Не удалось отправить стикер": { en: "Could not send the sticker", de: "Sticker konnte nicht gesendet werden", es: "No se pudo enviar el sticker" },   // Не удалось отправить стикер
  "Не удалось открыть ключ комнаты:": { en: "Could not open the room key:", de: "Raumschlüssel konnte nicht geöffnet werden:", es: "No se pudo abrir la clave de la sala" },   // Не удалось открыть ключ комнаты:
  "Нет доступа к камере или микрофону": { en: "No access to camera or microphone", de: "Kein Zugriff auf Kamera oder Mikrofon", es: "Sin acceso a la cámara o al micrófono" },   // Нет доступа к камере или микрофону
  "Нет доступа к микрофону": { en: "No access to the microphone", de: "Kein Zugriff auf das Mikrofon", es: "Sin acceso al micrófono" },   // Нет доступа к микрофону
  "Слишком коротко": { en: "Too short", de: "Zu kurz", es: "Demasiado corto" },   // Слишком коротко
  "Запись кружка": { en: "Recording a video circle", de: "Video-Kreis aufnehmen", es: "Grabando círculo de vídeo" },   // Запись кружка
  "Запись голосового": { en: "Recording a voice message", de: "Sprachnachricht aufnehmen", es: "Grabando mensaje de voz" },   // Запись голосового
  "Запись идёт. Отпустите палец, потом нажмите «отправить»": { en: "Recording. Release your finger, then tap “send”.", de: "Aufnahme läuft. Finger loslassen, dann „Senden“ tippen.", es: "Grabando. Suelte el dedo y toque «enviar»." },   // Запись идёт. Отпустите палец, потом нажмите «отправить»
  "Ведите вверх и отпустите — запись продолжится": { en: "Slide up and release — recording will continue", de: "Nach oben ziehen und loslassen — die Aufnahme läuft weiter", es: "Deslice hacia arriba y suelte: la grabación continuará" },   // Ведите вверх и отпустите — запись продолжится
  "Запись отменена": { en: "Recording canceled", de: "Aufnahme abgebrochen", es: "Grabación cancelada" },   // Запись отменена
  "Обои поставили обоим": { en: "Wallpaper set for both", de: "Hintergrund für beide gesetzt", es: "Fondo aplicado a ambos" },   // Обои поставили обоим
  "Обои изменены у вас": { en: "Wallpaper changed for you", de: "Hintergrund für Sie geändert", es: "Fondo cambiado para usted" },   // Обои изменены у вас
  "Секретный чат открыт": { en: "Secret chat opened", de: "Geheimer Chat geöffnet", es: "Chat secreto abierto" },   // Секретный чат открыт
  "Выйти из секретного чата": { en: "Leave the secret chat", de: "Geheimen Chat verlassen", es: "Salir del chat secreto" },   // Выйти из секретного чата
  "Ярлык добавлен на рабочий стол": { en: "Shortcut added to the home screen", de: "Verknüpfung zum Startbildschirm hinzugefügt", es: "Acceso directo añadido a la pantalla de inicio" },   // Ярлык добавлен на рабочий стол
  "Ярлык можно добавить в приложении на телефоне": { en: "The shortcut can be added in the phone app", de: "Die Verknüpfung lässt sich in der Handy-App hinzufügen", es: "El acceso directo se puede añadir en la app del teléfono" },   // Ярлык можно добавить в приложении на телефоне
  "Жалоба отправлена. Спасибо, что помогаете!": { en: "Report sent. Thanks for helping!", de: "Meldung gesendet. Danke für Ihre Hilfe!", es: "Denuncia enviada. ¡Gracias por ayudar!" },   // Жалоба отправлена. Спасибо, что помогаете!
  "Собеседник заблокирован": { en: "Contact blocked", de: "Kontakt blockiert", es: "Contacto bloqueado" },   // Собеседник заблокирован
  "Собеседник разблокирован": { en: "Contact unblocked", de: "Kontakt entsperrt", es: "Contacto desbloqueado" },   // Собеседник разблокирован
  "История очищена у обоих": { en: "History cleared for both", de: "Verlauf für beide gelöscht", es: "Historial borrado para ambos" },   // История очищена у обоих
  "История очищена у вас": { en: "History cleared for you", de: "Verlauf für Sie gelöscht", es: "Historial borrado para usted" },   // История очищена у вас
  "Чат удалён": { en: "Chat deleted", de: "Chat gelöscht", es: "Chat eliminado" },   // Чат удалён
  "Уведомления выключены": { en: "Notifications off", de: "Benachrichtigungen aus", es: "Notificaciones desactivadas" },   // Уведомления выключены
  "Уведомления включены": { en: "Notifications on", de: "Benachrichtigungen an", es: "Notificaciones activadas" },   // Уведомления включены
  "Очистить историю только у вас? Нажмите «Отмена», чтобы очистить у обоих.": { en: "Clear history only for you? Tap “Cancel” to clear for both.", de: "Verlauf nur für Sie löschen? „Abbrechen“ tippen, um für beide zu löschen.", es: "¿Borrar el historial solo para usted? Toque «Cancelar» para borrar para ambos." },   // Очистить историю только у вас? Нажмите «Отмена», чтобы очистить у обоих.
  "Удалить чат из списка?": { en: "Delete this chat from the list?", de: "Chat aus der Liste löschen?", es: "¿Eliminar este chat de la lista?" },   // Удалить чат из списка?
  "Выйти из аккаунта?": { en: "Sign out of your account?", de: "Vom Konto abmelden?", es: "¿Cerrar la sesión?" },   // Выйти из аккаунта?
  "Очистить данные на этом устройстве и выйти из аккаунта?": { en: "Clear data on this device and sign out?", de: "Daten auf diesem Gerät löschen und abmelden?", es: "¿Borrar los datos de este dispositivo y cerrar sesión?" },   // Очистить данные на этом устройстве и выйти из аккаунта?
  "Профиль сохранён": { en: "Profile saved", de: "Profil gespeichert", es: "Perfil guardado" },   // Профиль сохранён
  "Загружаю аватар…": { en: "Uploading avatar…", de: "Avatar wird hochgeladen…", es: "Subiendo avatar…" },   // Загружаю аватар…
  "Аватар загружен — не забудьте сохранить": { en: "Avatar uploaded — do not forget to save", de: "Avatar hochgeladen — bitte speichern", es: "Avatar subido: no olvide guardar" },   // Аватар загружен — не забудьте сохранить
  "Обновляю данные…": { en: "Updating data…", de: "Daten werden aktualisiert…", es: "Actualizando datos…" },   // Обновляю данные…
  "Пароль изменён. История сохранена": { en: "Password changed. History saved", de: "Passwort geändert. Verlauf gespeichert", es: "Contraseña cambiada. Historial guardado" },   // Пароль изменён. История сохранена
  "Старый пароль неверный": { en: "The old password is wrong", de: "Das alte Passwort ist falsch", es: "La contraseña anterior es incorrecta" },   // Старый пароль неверный
  "Новый пароль: минимум 6 символов": { en: "New password: at least 6 characters", de: "Neues Passwort: mindestens 6 Zeichen", es: "Nueva contraseña: mínimo 6 caracteres" },   // Новый пароль: минимум 6 символов
  "Новые пароли не совпадают": { en: "The new passwords do not match", de: "Die neuen Passwörter stimmen nicht überein", es: "Las nuevas contraseñas no coinciden" },   // Новые пароли не совпадают
  "Канал создан": { en: "Channel created", de: "Kanal erstellt", es: "Canal creado" },   // Канал создан
  "Группа создана": { en: "Group created", de: "Gruppe erstellt", es: "Grupo creado" },   // Группа создана
  "Вы вышли из комнаты": { en: "You left the room", de: "Sie haben den Raum verlassen", es: "Salió de la sala" },   // Вы вышли из комнаты
  "владелец": { en: "owner", de: "Eigentümer", es: "propietario" },   // владелец
  "админ": { en: "admin", de: "Admin", es: "administrador" },   // админ
  "участник": { en: "member", de: "Mitglied", es: "miembro" },   // участник
  "Удалить из комнаты": { en: "Remove from the room", de: "Aus dem Raum entfernen", es: "Eliminar de la sala" },   // Удалить из комнаты
  "Новое сообщение": { en: "New message", de: "Neue Nachricht", es: "Nuevo mensaje" },   // Новое сообщение
  "Набор удалён": { en: "Set deleted", de: "Set gelöscht", es: "Set eliminado" },   // Набор удалён
  "Набор добавлен в стикеры": { en: "Set added to stickers", de: "Set zu Stickern hinzugefügt", es: "Set añadido a los stickers" },   // Набор добавлен в стикеры
  "Выберите картинки": { en: "Choose pictures", de: "Wählen Sie Bilder", es: "Elija imágenes" },   // Выберите картинки
  "Новый набор стикеров": { en: "New sticker set", de: "Neues Sticker-Set", es: "Nuevo set de stickers" },   // Новый набор стикеров
  "Мои наборы стикеров": { en: "My sticker sets", de: "Meine Sticker-Sets", es: "Mis sets de stickers" },   // Мои наборы стикеров
  "Создать набор стикеров": { en: "Create a sticker set", de: "Sticker-Set erstellen", es: "Crear set de stickers" },   // Создать набор стикеров
  "Устройство отключено": { en: "Device disconnected", de: "Gerät getrennt", es: "Dispositivo desconectado" },   // Устройство отключено
  "Бот удалён": { en: "Bot deleted", de: "Bot gelöscht", es: "Bot eliminado" },   // Бот удалён
  "Бот создан. Сохраните токен и запустите программу бота": { en: "Bot created. Save the token and start your bot program.", de: "Bot erstellt. Token speichern und Bot-Programm starten.", es: "Bot creado. Guarde el token y ejecute el programa del bot." },   // Бот создан. Сохраните токен и запустите программу бота
  "Подождите секунду и попробуйте снова": { en: "Wait a second and try again", de: "Warten Sie einen Moment und versuchen Sie es erneut", es: "Espere un segundo e inténtelo de nuevo" },   // Подождите секунду и попробуйте снова
  "Сервер не отвечает. Проверьте интернет — попробуем снова.": { en: "The server is not responding. Check your connection — we will retry.", de: "Der Server antwortet nicht. Prüfen Sie die Verbindung — wir versuchen es erneut.", es: "El servidor no responde. Compruebe la conexión; lo intentaremos de nuevo." },   // Сервер не отвечает. Проверьте интернет — попробуем снова.
  "Сервер просыпается… попытка": { en: "The server is waking up… attempt", de: "Der Server wacht auf… Versuch", es: "El servidor está despertando… intento" },   // Сервер просыпается… попытка
  "Нет связи с сервером… пробую снова": { en: "No connection to the server… retrying", de: "Keine Verbindung zum Server… neuer Versuch", es: "Sin conexión con el servidor… reintentando" },   // Нет связи с сервером… пробую снова
  "Связь потеряна… восстанавливаю": { en: "Connection lost… restoring", de: "Verbindung verloren… Wiederherstellung", es: "Conexión perdida… restaurando" },   // Связь потеряна… восстанавливаю
  "Проверяем данные…": { en: "Checking your data…", de: "Daten werden geprüft…", es: "Comprobando los datos…" },   // Проверяем данные…
  "Создаём профиль…": { en: "Creating your profile…", de: "Profil wird erstellt…", es: "Creando el perfil…" },   // Создаём профиль…
  "Проверяем пароль…": { en: "Checking the password…", de: "Passwort wird geprüft…", es: "Comprobando la contraseña…" },   // Проверяем пароль…
  "Ошибка входа:": { en: "Sign-in error:", de: "Anmeldefehler:", es: "Error de inicio de sesión:" },   // Ошибка входа:
  "Не удалось открыть переписку на этом устройстве. Попробуйте войти заново": { en: "Could not open your chats on this device. Please sign in again.", de: "Chats konnten auf diesem Gerät nicht geöffnet werden. Bitte erneut anmelden.", es: "No se pudieron abrir los chats en este dispositivo. Inicie sesión de nuevo." },   // Не удалось открыть переписку на этом устройстве. Попробуйте войти заново
  "Сообщение глубже в истории — прокрутите ленту": { en: "The message is deeper in history — scroll the feed", de: "Die Nachricht liegt weiter oben — scrollen Sie", es: "El mensaje está más atrás; desplace la lista" },   // Сообщение глубже в истории — прокрутите ленту
  "Доступ к этой комнате ещё не открыт — попросите администратора": { en: "Access to this room is not open yet — ask an administrator", de: "Der Zugang zu diesem Raum ist noch nicht offen — fragen Sie einen Administrator", es: "El acceso a esta sala aún no está abierto; pida al administrador" },   // Доступ к этой комнате ещё не открыт — попросите администратора
  "Собеседник ещё не готов к переписке — попробуйте через секунду": { en: "The contact is not ready to chat yet — try again in a second", de: "Der Kontakt ist noch nicht bereit — versuchen Sie es in einer Sekunde", es: "El contacto aún no está listo; inténtelo en un segundo" },   // Собеседник ещё не готов к переписке — попробуйте через секунду
  "Доступ к комнате открыт — можно писать": { en: "Room access is open — you can write", de: "Raumzugang ist offen — Sie können schreiben", es: "Acceso a la sala abierto; puede escribir" },   // Доступ к комнате открыт — можно писать
  "Доступ к переписке открыт": { en: "Chat access is open", de: "Chat-Zugang ist offen", es: "Acceso al chat abierto" },   // Доступ к переписке открыт
  "Приложение устанавливается…": { en: "Installing the app…", de: "App wird installiert…", es: "Instalando la aplicación…" },   // Приложение устанавливается…
  "Вы уже пользуетесь приложением": { en: "You are already using the app", de: "Sie nutzen die App bereits", es: "Ya está usando la aplicación" },   // Вы уже пользуетесь приложением
  "Уведомления не поддерживаются": { en: "Notifications are not supported", de: "Benachrichtigungen werden nicht unterstützt", es: "Las notificaciones no son compatibles" },   // Уведомления не поддерживаются
  "История опубликована на 24 часа": { en: "Story published for 24 hours", de: "Story für 24 Stunden veröffentlicht", es: "Historia publicada por 24 horas" },   // История опубликована на 24 часа
  "История удалена": { en: "Story deleted", de: "Story gelöscht", es: "Historia eliminada" },   // История удалена
  "просмотр": { en: "view", de: "Aufruf", es: "vista" },   // просмотр
  "просмотра": { en: "views", de: "Aufrufe", es: "vistas" },   // просмотра
  "просмотров": { en: "views", de: "Aufrufe", es: "vistas" },   // просмотров
  "Медиафайл удалён": { en: "Media deleted", de: "Medium gelöscht", es: "Multimedia eliminado" },   // Медиафайл удалён
  "КБ": { en: "KB", de: "KB", es: "KB" },   // КБ
  "МБ": { en: "MB", de: "MB", es: "MB" },   // МБ
  "Б": { en: "B", de: "B", es: "B" },   // Б
  "Язык": { en: "Language", de: "Sprache", es: "Idioma" },   // Язык
};

// ---------------------------------------------------------------------------
//  ДВИЖОК ПЕРЕВОДА
// ---------------------------------------------------------------------------
window.gmTranslate = function (text) {                             // переводит одну надпись на выбранный язык
  const lang = window.gmLang || "ru";                              // какой язык выбран сейчас
  if (lang === "ru") return text;                                  // русский — переводить не нужно
  if (text === undefined || text === null) return text;            // пустое значение — возвращаем как есть
  const raw = String(text);                                        // надпись в виде текста
  const trimmed = raw.trim();                                      // без пробелов по краям (так её ищем в словаре)
  if (!trimmed) return text;                                       // одни пробелы — возвращаем как было
  const entry = window.GM_I18N[trimmed];                           // запись словаря для этой надписи
  if (!entry || !entry[lang]) return text;                         // перевода нет — оставляем русский текст
  const lead = raw.slice(0, raw.indexOf(trimmed));                 // пробелы перед надписью
  const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length);   // пробелы после надписи
  return lead + entry[lang] + tail;                                // отдаём перевод с теми же пробелами
};

window.gmApplyLanguage = function (lang) {                         // переводит весь интерфейс на выбранный язык
  if (lang) window.gmLang = lang;                                  // если язык передали — запоминаем его
  const current = window.gmLang || "ru";                           // текущий язык
  document.documentElement.setAttribute("lang", current);          // помечаем язык страницы (это видят системы и переводчики)
  const body = document.body;                                      // тело страницы
  if (!body) return;                                               // страницы ещё нет — выходим
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);   // обходим все текстовые узлы
  const узлы = [];                                                 // соберём их в список (чтобы не менять дерево на ходу)
  while (walker.nextNode()) узлы.push(walker.currentNode);         // собираем узлы один за другим
  for (const node of узлы) {                                       // идём по каждому узлу
    const parent = node.parentElement;                             // родительский элемент узла
    if (!parent) continue;                                         // родителя нет — пропускаем
    const tag = parent.tagName;                                    // имя тега («BUTTON», «SPAN», …)
    if (tag === "SCRIPT" || tag === "STYLE") continue;             // внутрь кода и стилей не лезем
    if (node.__gmRu === undefined) node.__gmRu = node.nodeValue;   // при первом проходе запоминаем русский оригинал
    const source = node.__gmRu;                                    // берём именно оригинал (так язык можно менять много раз)
    const next = window.gmTranslate(source);                       // переводим его
    if (next !== node.nodeValue) node.nodeValue = next;            // если текст отличается — подставляем перевод
  }
  const атрибуты = ["placeholder", "title", "aria-label"];         // подписи, которые живут в атрибутах
  for (const el of body.querySelectorAll("[placeholder], [title], [aria-label]")) {   // ищем элементы с подсказками
    for (const name of атрибуты) {                                 // по каждому атрибуту
      const value = el.getAttribute(name);                         // что там написано
      if (value === null) continue;                                // атрибута нет — пропускаем
      const store = "__gmRu" + name;                               // где храним русский оригинал
      if (el[store] === undefined) el[store] = value;              // запоминаем оригинал при первом проходе
      const next = window.gmTranslate(el[store]);                  // переводим
      if (next !== el.getAttribute(name)) el.setAttribute(name, next);   // подставляем перевод, если он есть
    }
  }
  const место = document.getElementById("lang-picker");           // список языков в настройках
  if (место) {                                                     // он есть —
    for (const card of место.querySelectorAll("[data-lang]")) {    //   отмечаем выбранный язык
      card.classList.toggle("active", card.getAttribute("data-lang") === current);   // подсвечиваем карточку
    }
  }
  window.dispatchEvent(new CustomEvent("gm:lang", { detail: current }));   // сообщаем всем, что язык сменился
};

window.gmSetLanguage = function (lang, save) {                     // смена языка человеком
  window.gmLang = lang || "ru";                                    // запоминаем выбор
  if (save !== false) {                                            // обычно выбор нужно запомнить —
    try { localStorage.setItem("gm_lang", window.gmLang); } catch (e) { /* память недоступна — не беда */ }
  }
  window.gmApplyLanguage(window.gmLang);                           // сразу переводим интерфейс
  return window.gmLang;                                            // отдаём выбранный язык
};

window.gmStartLanguageWatch = function () {                        // следим за новыми надписями (чаты, меню, подсказки)
  let занято = false;                                              // признак: перевод уже выполняется
  const observer = new MutationObserver(function () {              // при любом изменении страницы
    if (занято) return;                                            // мы сами только что меняли текст — не зацикливаемся
    занято = true;                                                 // помечаем, что работаем
    setTimeout(function () {                                       // небольшая задержка, чтобы не переводить по десять раз подряд
      занято = false;                                              // снимаем признак
      if ((window.gmLang || "ru") !== "ru") window.gmApplyLanguage();   // переводим новые надписи (если язык не русский)
    }, 150);                                                       // 150 мс — незаметно для глаза
  });
  observer.observe(document.body, { childList: true, subtree: true });   // наблюдаем за всем деревом страницы
  return observer;                                                 // отдаём наблюдателя (может пригодиться)
};

window.gmBuildLangPicker = function (container) {                  // собирает карточки языков в настройках
  if (!container) return;                                          // места нет — выходим
  container.innerHTML = "";                                        // очищаем список
  for (const lang of window.GM_LANGS) {                            // идём по всем языкам
    const card = document.createElement("button");                 // создаём кнопку-карточку
    card.className = "theme-card lang-card";                       // тот же вид, что у карточек тем
    card.setAttribute("data-lang", lang.code);                     // помечаем код языка
    card.textContent = lang.title;                                 // название языка (оно одинаково на всех языках)
    card.addEventListener("click", function () {                   // по нажатию —
      window.gmSetLanguage(lang.code, true);                       //   меняем язык и запоминаем выбор
      if (window.gmSaveSettingsSoon) window.gmSaveSettingsSoon();  //   и просим сохранить настройки в профиль
    });
    container.appendChild(card);                                   // добавляем карточку в список
  }
  const текущий = document.getElementById("lang-picker");         // наш список языков
  if (текущий) {                                                   // он есть —
    for (const card of текущий.querySelectorAll("[data-lang]")) {  //   отмечаем выбранный язык
      card.classList.toggle("active", card.getAttribute("data-lang") === (window.gmLang || "ru"));   // подсветка выбранной карточки
    }
  }
};

// ---------------------------------------------------------------------------
//  ПЕРВЫЙ ЗАПУСК: берём язык из памяти устройства
// ---------------------------------------------------------------------------
try {                                                              // память устройства может быть недоступна —
  const saved = localStorage.getItem("gm_lang");                   // вспоминаем, какой язык выбирал человек
  if (saved && window.GM_LANGS.some((l) => l.code === saved)) window.gmLang = saved;   // если такой язык есть — используем его
} catch (e) { /* не получилось — остаёмся на русском */ }
