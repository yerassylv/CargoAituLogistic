const API_URL = "https://cargoaitulogistic.onrender.com";

const loginBtn = document.getElementById("loginBtn");

const loginText = document.getElementById("loginText");

const loginLoader = document.getElementById("loginLoader");

const authMessage = document.getElementById("authMessage");

const ncalayerStatus = document.getElementById("ncalayerStatus");

let ncalayerClient = null;

let authInProgress = false;

async function initNCALayer() {
    if (typeof NCALayerClient === "undefined") {
        await Promise.race([ new Promise(resolve => {
            window.addEventListener("ncalayer-loaded", resolve, {
                once: true
            });
        }), new Promise(resolve => setTimeout(resolve, 3e3)) ]);
    }
    if (typeof NCALayerClient === "undefined") {
        ncalayerStatus.innerHTML = `\n            <div class="status-invalid">\n                Библиотека NCALayer не загружена.<br>\n                <small>Убедитесь, что есть подключение к интернету.</small>\n            </div>\n        `;
        return false;
    }
    try {
        ncalayerClient = new NCALayerClient;
        console.log("Подключение к NCALayer...");
        await ncalayerClient.connect();
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
            await ncalayerClient.getActiveTokens();
            console.log("Соединение с NCALayer установлено");
        } catch (e) {
            console.log("Предупреждение: не удалось проверить соединение, но продолжаем:", e.message);
        }
        ncalayerStatus.innerHTML = '<div class="status-valid">NCALayer обнаружен и готов к работе</div>';
        return true;
    } catch (error) {
        console.error("Ошибка подключения к NCALayer:", error);
        ncalayerStatus.innerHTML = `\n            <div class="status-invalid">\n                NCALayer не обнаружен.<br>\n                <small>Убедитесь, что:</small>\n                <ul>\n                    <li>Приложение NCALayer запущено</li>\n                    <li>Подключен токен или смарт-карта</li>\n                </ul>\n                <small>Ошибка: ${error.message || "Неизвестная ошибка"}</small>\n            </div>\n        `;
        return false;
    }
}

async function checkNCALayerWebSocket() {
    return new Promise(resolve => {
        const ws = new WebSocket("wss://127.0.0.1:13579");
        ws.onopen = () => {
            ws.close();
            resolve(true);
        };
        ws.onerror = () => {
            resolve(false);
        };
        setTimeout(() => {
            ws.close();
            resolve(false);
        }, 2e3);
    });
}

async function getNonce() {
    const res = await fetch(`${API_URL}/auth/nonce`);
    if (!res.ok) {
        throw new Error("Не удалось получить nonce");
    }
    const {nonce: nonce} = await res.json();
    return nonce;
}

async function performAuth() {
    if (authInProgress) {
        console.log("Авторизация уже выполняется, игнорируем повторный клик");
        return;
    }
    authInProgress = true;
    authMessage.className = "form-message";
    authMessage.textContent = "";
    loginBtn.disabled = true;
    loginText.style.display = "none";
    loginLoader.style.display = "inline-block";
    try {
        const wsAvailable = await checkNCALayerWebSocket();
        if (!wsAvailable) {
            throw new Error("NCALayer не доступен. Запустите приложение NCALayer на вашем компьютере.");
        }
        authMessage.className = "form-message";
        authMessage.textContent = "Подключение к NCALayer...";
        const ncalayerReady = await initNCALayer();
        if (!ncalayerReady) {
            throw new Error("Не удалось подключиться к NCALayer. Убедитесь, что приложение запущено.");
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        authMessage.textContent = "Запрос одноразового кода...";
        const nonce = await getNonce();
        authMessage.textContent = "Подпись данных... (выберите токен в диалоге NCALayer)";
        const xml = `<nonce>${nonce}</nonce>`;
        const signedXml = await ncalayerClient.signXml("PKCS12", xml);
        authMessage.textContent = "Проверка подписи...";
        const verifyResponse = await fetch(`${API_URL}/auth/verify`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                signedXml: signedXml
            })
        });
        if (!verifyResponse.ok) {
            const errorText = await verifyResponse.text();
            throw new Error(errorText || "Ошибка верификации");
        }
        const verifyData = await verifyResponse.json();
        try {
            localStorage.setItem("user", JSON.stringify(verifyData.user));
            localStorage.setItem("isAuthenticated", "true");
        } catch (error) {
            console.error("Ошибка при сохранении в localStorage:", error);
        }
        authMessage.className = "form-message success";
        authMessage.innerHTML = `\n            <strong>${verifyData.message}</strong>\n            <p>Пользователь: ${verifyData.user.full_name} (ИИН: ${verifyData.user.iin})</p>\n            <p>${verifyData.is_new_user ? "Вы были зарегистрированы" : "Выполнен вход в систему"}</p>\n        `;
        setTimeout(() => {
            if (typeof navigateWithTransition === "function") {
                navigateWithTransition("index.html");
            } else {
                window.location.replace("index.html");
            }
        }, 2e3);
    } catch (error) {
        authMessage.className = "form-message error";
        authMessage.innerHTML = `<strong>Ошибка:</strong> ${error.message}`;
        console.error("Ошибка авторизации:", error);
    } finally {
        authInProgress = false;
        loginBtn.disabled = false;
        loginText.style.display = "inline";
        loginLoader.style.display = "none";
    }
}

loginBtn.addEventListener("click", performAuth);

window.addEventListener("load", async () => {
    await initNCALayer();
});