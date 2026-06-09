const API_URL = "https://cargoplatform.onrender.com";

const fileStep = document.getElementById("fileStep");

const uploadForm = document.getElementById("certificateUploadForm");

const reviewStep = document.getElementById("reviewStep");

const extractBtn = document.getElementById("extractBtn");

const extractText = document.getElementById("extractText");

const extractLoader = document.getElementById("extractLoader");

const confirmBtn = document.getElementById("confirmBtn");

const confirmText = document.getElementById("confirmText");

const confirmLoader = document.getElementById("confirmLoader");

const backBtn = document.getElementById("backBtn");

const uploadMessage = document.getElementById("uploadMessage");

const reviewMessage = document.getElementById("reviewMessage");

const extractedDataDiv = document.getElementById("extractedData");

let certificateFile = null;

let certificatePassword = "";

let extractedData = null;

uploadForm.addEventListener("submit", async e => {
    e.preventDefault();
    uploadMessage.className = "form-message";
    uploadMessage.textContent = "";
    extractBtn.disabled = true;
    extractText.style.display = "none";
    extractLoader.style.display = "inline-block";
    try {
        certificateFile = document.getElementById("ecpCertificate").files[0];
        certificatePassword = document.getElementById("certificatePassword").value || "";
        if (!certificateFile) {
            throw new Error("Необходимо выбрать файл сертификата ЭЦП");
        }
        if (certificateFile.size > 5 * 1024 * 1024) {
            throw new Error("Размер файла не должен превышать 5MB");
        }
        const formData = new FormData;
        formData.append("ecp_certificate", certificateFile);
        if (certificatePassword) {
            formData.append("password", certificatePassword);
        }
        const response = await fetch(`${API_URL}/api/extract-certificate`, {
            method: "POST",
            body: formData
        });
        const data = await response.json();
        if (response.ok) {
            extractedData = data.data;
            displayExtractedData(extractedData);
            fileStep.style.display = "none";
            reviewStep.style.display = "block";
        } else {
            throw new Error(data.detail || "Ошибка при извлечении данных");
        }
    } catch (error) {
        uploadMessage.className = "form-message error";
        uploadMessage.innerHTML = `<strong>Ошибка:</strong> ${error.message}`;
    } finally {
        extractBtn.disabled = false;
        extractText.style.display = "inline";
        extractLoader.style.display = "none";
    }
});

function displayExtractedData(data) {
    const formatDate = dateStr => {
        if (!dateStr) return "Не указано";
        const date = new Date(dateStr);
        return date.toLocaleDateString("ru-RU", {
            year: "numeric",
            month: "long",
            day: "numeric"
        });
    };
    extractedDataDiv.innerHTML = `\n        <div class="data-row">\n            <span class="data-label">ФИО:</span>\n            <span class="data-value">${data.full_name || "Не указано"}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Email:</span>\n            <span class="data-value">${data.email || "Не указано"}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Название компании:</span>\n            <span class="data-value">${data.company_name || "Не указано"}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">ИНН:</span>\n            <span class="data-value">${data.inn || "Не указано"}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Серийный номер сертификата:</span>\n            <span class="data-value">${data.serial_number || "Не указано"}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Издатель сертификата:</span>\n            <span class="data-value">${data.issuer || "Не указано"}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Действителен с:</span>\n            <span class="data-value">${formatDate(data.valid_from)}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Действителен до:</span>\n            <span class="data-value">${formatDate(data.valid_to)}</span>\n        </div>\n        <div class="data-row">\n            <span class="data-label">Статус:</span>\n            <span class="data-value ${data.is_valid ? "status-valid" : "status-invalid"}">\n                ${data.is_valid ? "Действителен" : "Недействителен"}\n            </span>\n        </div>\n    `;
}

backBtn.addEventListener("click", () => {
    reviewStep.style.display = "none";
    fileStep.style.display = "block";
    extractedData = null;
});

confirmBtn.addEventListener("click", async () => {
    if (!extractedData) {
        reviewMessage.className = "form-message error";
        reviewMessage.textContent = "Ошибка: данные сертификата не найдены";
        return;
    }
    reviewMessage.className = "form-message";
    reviewMessage.textContent = "";
    confirmBtn.disabled = true;
    confirmText.style.display = "none";
    confirmLoader.style.display = "inline-block";
    try {
        const formData = new FormData;
        formData.append("ecp_certificate", certificateFile);
        if (certificatePassword) {
            formData.append("password", certificatePassword);
        }
        const response = await fetch(`${API_URL}/api/register`, {
            method: "POST",
            body: formData
        });
        const data = await response.json();
        if (response.ok) {
            reviewMessage.className = "form-message success";
            reviewMessage.innerHTML = `\n                <strong>${data.message}</strong>\n                <p>Пользователь: ${data.user.full_name} (${data.user.email})</p>\n                <p>Сертификат ЭЦП: ${data.user.ecp_serial_number}</p>\n            `;
            setTimeout(() => {
                window.location.href = "index.html";
            }, 3e3);
        } else {
            throw new Error(data.detail || "Ошибка при регистрации");
        }
    } catch (error) {
        reviewMessage.className = "form-message error";
        reviewMessage.innerHTML = `<strong>Ошибка:</strong> ${error.message}`;
    } finally {
        confirmBtn.disabled = false;
        confirmText.style.display = "inline";
        confirmLoader.style.display = "none";
    }
});