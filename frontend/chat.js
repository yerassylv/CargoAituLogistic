let chatOpen = false;

let chatSuggestionsRevealed = false;

function getChatApiBase() {
    if (typeof API_URL !== "undefined" && API_URL) {
        return String(API_URL).replace(/\/$/, "");
    }
    return "https://cargoaitulogistic.onrender.com";
}

function chatRandomDelayMs() {
    return 300 + Math.random() * 500;
}

function chatDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function scrollChatToBottom() {
    const el = document.getElementById("chatMessages");
    if (!el) return;
    requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
    });
}

function hideChatOnboarding() {
    const block = document.getElementById("chatOnboarding");
    if (block) block.classList.add("chat-onboarding--hidden");
}

function hideChatQuickActions() {
    const qa = document.getElementById("chatQuickActions");
    if (qa) qa.classList.add("chat-actions--hidden");
}

function maybeShowSmartSuggestions() {
    if (chatSuggestionsRevealed) return;
    const el = document.getElementById("chatSuggestions");
    if (!el) return;
    chatSuggestionsRevealed = true;
    el.classList.add("chat-suggestions--visible");
    el.setAttribute("aria-hidden", "false");
    scrollChatToBottom();
}

function toggleChat() {
    const chatModal = document.getElementById("chatModal");
    const chatButton = document.getElementById("chatButton");
    chatOpen = !chatOpen;
    if (chatOpen) {
        chatModal.classList.add("open");
        chatButton.classList.add("active");
        if (typeof lockBodyScroll === "function") {
            lockBodyScroll();
        }
        setTimeout(() => {
            const input = document.getElementById("chatInput");
            if (input) input.focus();
            scrollChatToBottom();
        }, 120);
    } else {
        chatModal.classList.remove("open");
        chatButton.classList.remove("active");
        if (typeof unlockBodyScroll === "function") {
            unlockBodyScroll();
        }
    }
}

function handleChatKeyPress(event) {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
    }
}

async function sendChatMessage() {
    const input = document.getElementById("chatInput");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    await sendChatWithUserText(message);
}

async function sendChatWithUserText(message) {
    hideChatOnboarding();
    hideChatQuickActions();
    addChatMessage(message, "user");
    await replyAsBot(message);
}

async function replyAsBot(userMessage) {
    const typingEl = showTypingIndicator();
    await chatDelay(chatRandomDelayMs());
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const base = getChatApiBase();
    try {
        const response = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-Id": user.id ? user.id.toString() : ""
            },
            body: JSON.stringify({
                message: userMessage
            })
        });
        removeChatMessage(typingEl);
        if (!response.ok) {
            throw new Error("Ошибка при получении ответа");
        }
        const data = await response.json();
        addChatMessage(data.response, "bot");
        maybeShowSmartSuggestions();
    } catch (error) {
        console.error("Ошибка:", error);
        removeChatMessage(typingEl);
        addChatMessage(getBotResponse(userMessage), "bot");
        maybeShowSmartSuggestions();
    }
}

function botAvatarHtml() {
    return `\n    <div class="chat-message-avatar" aria-hidden="true">\n      <span class="chat-message-avatar-inner">C</span>\n    </div>`;
}

function showTypingIndicator() {
    const messagesContainer = document.getElementById("chatMessages");
    const wrap = document.createElement("div");
    wrap.className = "chat-typing-wrap chat-message--enter";
    wrap.setAttribute("data-chat-typing", "1");
    wrap.innerHTML = `\n    ${botAvatarHtml()}\n    <div class="chat-typing-panel" aria-hidden="true">\n      <div class="chat-typing-dots">\n        <span></span><span></span><span></span>\n      </div>\n    </div>\n  `;
    messagesContainer.appendChild(wrap);
    scrollChatToBottom();
    return wrap;
}

function addChatMessage(text, sender) {
    const messagesContainer = document.getElementById("chatMessages");
    const messageDiv = document.createElement("div");
    messageDiv.className = `chat-message chat-message-${sender} chat-message--enter`;
    if (sender === "bot") {
        messageDiv.innerHTML = `\n      ${botAvatarHtml()}\n      <div class="chat-message-inner">\n        <div class="chat-message-content chat-panel chat-panel--bot">\n          <p class="chat-panel-text chat-panel-text--bot">${escapeHtml(text)}</p>\n        </div>\n      </div>\n    `;
    } else {
        messageDiv.innerHTML = `\n      <div class="chat-message-inner">\n        <div class="chat-message-content chat-panel chat-panel--user">\n          <p class="chat-panel-text">${escapeHtml(text)}</p>\n        </div>\n      </div>\n    `;
    }
    messagesContainer.appendChild(messageDiv);
    scrollChatToBottom();
    return messageDiv;
}

function removeChatMessage(messageElement) {
    if (messageElement && messageElement.parentNode) {
        messageElement.parentNode.removeChild(messageElement);
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function getBotResponse(message) {
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes("привет") || lowerMessage.includes("здравствуй")) {
        return "Здравствуйте! Я виртуальный помощник CargoAitu. Чем могу помочь?";
    }
    if (lowerMessage.includes("ты ии") || lowerMessage.includes("ты ai") || lowerMessage.includes("искусственный интеллект")) {
        return "Да, я AI-ассистент! Но сейчас у меня временные проблемы с подключением к сервису. Пока я могу отвечать на основе ключевых слов. Если нужна более подробная помощь, свяжитесь с поддержкой: 8 800 250-02-00 или support@cargoaitu.kz";
    }
    if (lowerMessage.includes("помощь") || lowerMessage.includes("помоги")) {
        return "Я могу помочь вам с вопросами о работе платформы CargoAitu. Вы можете спросить о создании заявок, подаче предложений, работе с документами и многом другом.";
    }
    if (lowerMessage.includes("заявк") || lowerMessage.includes("создать")) {
        return 'Для создания заявки нажмите кнопку "Создать заявку" в верхней части страницы. Заполните все необходимые поля: маршрут, тип груза, цену и условия перевозки. Расстояние между городами рассчитается автоматически!';
    }
    if (lowerMessage.includes("предложен") || lowerMessage.includes("ставк")) {
        return 'Для подачи предложения найдите интересующую вас заявку в списке и нажмите кнопку "Подать предложение". Укажите цену, время доставки и другую информацию.';
    }
    if (lowerMessage.includes("контакт") || lowerMessage.includes("телефон") || lowerMessage.includes("email")) {
        return "Связаться с нами можно по телефону: 8 800 250-02-00 или по email: support@cargoaitu.kz";
    }
    if (lowerMessage.includes("документ")) {
        return 'Документы можно загружать и просматривать в разделе "Документы" в профиле пользователя. Также можно подписывать документы через ЭЦП прямо на платформе.';
    }
    if (lowerMessage.includes("оплат") || lowerMessage.includes("платеж")) {
        return "Вопросы по оплате решаются напрямую между заказчиком и перевозчиком. Платформа обеспечивает безопасность сделок.";
    }
    return "Спасибо за ваш вопрос! Я AI-ассистент, но сейчас у меня временные проблемы с подключением. Для получения более подробной информации свяжитесь с нашей поддержкой по телефону 8 800 250-02-00 или email support@cargoaitu.kz";
}

document.addEventListener("click", e => {
    const chatModal = document.getElementById("chatModal");
    const chatButton = document.getElementById("chatButton");
    if (chatOpen && chatModal && chatButton && !chatModal.contains(e.target) && !chatButton.contains(e.target)) {
        toggleChat();
    }
});

function initChatQuickDelegation() {
    const root = document.getElementById("chatModal");
    if (!root || root.dataset.quickBound === "1") return;
    root.dataset.quickBound = "1";
    root.addEventListener("click", e => {
        const btn = e.target.closest("[data-chat-quick]");
        if (!btn || !root.contains(btn)) return;
        const text = btn.getAttribute("data-chat-quick");
        if (text) {
            sendChatWithUserText(text);
        }
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChatQuickDelegation);
} else {
    initChatQuickDelegation();
}

window.toggleChat = toggleChat;

window.handleChatKeyPress = handleChatKeyPress;

window.sendChatMessage = sendChatMessage;