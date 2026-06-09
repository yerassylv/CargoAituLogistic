function showToast(message, type = "info", title = null, duration = 3e3) {
    const container = document.getElementById("toastContainer");
    if (!container) {
        const newContainer = document.createElement("div");
        newContainer.id = "toastContainer";
        newContainer.className = "toast-container";
        document.body.appendChild(newContainer);
        return showToast(message, type, title, duration);
    }
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    const icons = {
        success: "✓",
        error: "✕",
        warning: "⚠",
        info: "ℹ"
    };
    const defaultTitles = {
        success: "Успешно",
        error: "Ошибка",
        warning: "Внимание",
        info: "Информация"
    };
    const toastTitle = title || defaultTitles[type] || "Уведомление";
    toast.innerHTML = `\n    <div class="toast-icon">${icons[type] || icons.info}</div>\n    <div class="toast-content">\n      <div class="toast-title">${escapeHtml(toastTitle)}</div>\n      <div class="toast-message">${escapeHtml(message)}</div>\n    </div>\n    <button class="toast-close" onclick="this.closest('.toast').remove()">\n      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">\n        <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>\n      </svg>\n    </button>\n  `;
    container.appendChild(toast);
    if (duration > 0) {
        setTimeout(() => {
            removeToast(toast);
        }, duration);
    }
    return toast;
}

function removeToast(toast) {
    if (!toast) return;
    toast.classList.add("toast-slide-out");
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function showSuccess(message, title = null) {
    return showToast(message, "success", title, 3e3);
}

function showError(message, title = null) {
    return showToast(message, "error", title, 5e3);
}

function showWarning(message, title = null) {
    return showToast(message, "warning", title, 4e3);
}

function showInfo(message, title = null) {
    return showToast(message, "info", title, 3e3);
}

window.showToast = showToast;

window.showSuccess = showSuccess;

window.showError = showError;

window.showWarning = showWarning;

window.showInfo = showInfo;

window.removeToast = removeToast;