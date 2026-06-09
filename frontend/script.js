const API_URL = "https://cargoaitulogistic.onrender.com";

const checkAuth = () => {
    const userStr = localStorage.getItem("user");
    const isAuth = localStorage.getItem("isAuthenticated") === "true";
    return {
        userStr: userStr,
        isAuth: isAuth
    };
};

async function checkServerStatus() {
    const statusDiv = document.getElementById("status");
    if (!statusDiv) return;
    try {
        const response = await fetch(`${API_URL}/api/health`);
        const data = await response.json();
        if (response.ok) {
            statusDiv.innerHTML = `\n                <p><strong>Сервер работает</strong></p>\n                <p>Статус: ${data.status}</p>\n                <p>Сервис: ${data.service}</p>\n            `;
            statusDiv.className = "status-box success";
        } else {
            throw new Error("Ошибка ответа сервера");
        }
    } catch (error) {
        statusDiv.innerHTML = `\n            <p><strong>Ошибка подключения</strong></p>\n            <p>${error.message}</p>\n        `;
        statusDiv.className = "status-box error";
    }
}

function toggleLandingPage() {
    const userStr = localStorage.getItem("user");
    const isAuth = localStorage.getItem("isAuthenticated") === "true";
    const isAuthenticated = userStr && isAuth;
    const landingPage = document.getElementById("landingPage");
    const mainContent = document.getElementById("mainContent");
    const organizationsSection = document.getElementById("organizationsSection");
    const headerNav = document.getElementById("mainNav");
    const header = document.querySelector(".header");
    if (isAuthenticated) {
        document.body.classList.remove("landing-page-active");
        document.body.classList.add("authenticated");
        if (landingPage) landingPage.style.display = "none";
        const activeNavItem = document.querySelector(".nav-item.active");
        const activePage = activeNavItem?.dataset.page || "requests";
        if (typeof window.switchPage === "function") {
            window.switchPage(activePage);
        } else {
            const mainContent2 = document.getElementById("mainContent");
            const organizationsSection2 = document.getElementById("organizationsSection");
            const partnersSection = document.getElementById("partnersSection");
            if (activePage === "requests") {
                if (mainContent2) {
                    mainContent2.classList.add("page-visible");
                    mainContent2.classList.remove("page-hidden");
                }
                if (organizationsSection2) {
                    organizationsSection2.classList.add("page-hidden");
                    organizationsSection2.classList.remove("page-visible");
                }
                if (partnersSection) {
                    partnersSection.classList.add("page-hidden");
                    partnersSection.classList.remove("page-visible");
                }
                document.body.classList.remove("page-organizations", "page-partners");
                document.body.classList.add("page-requests");
            } else if (activePage === "organizations") {
                if (organizationsSection2) {
                    organizationsSection2.classList.add("page-visible");
                    organizationsSection2.classList.remove("page-hidden");
                }
                if (partnersSection) {
                    partnersSection.classList.add("page-hidden");
                    partnersSection.classList.remove("page-visible");
                }
                if (mainContent2) {
                    mainContent2.classList.add("page-hidden");
                    mainContent2.classList.remove("page-visible");
                }
                document.body.classList.remove("page-requests", "page-partners");
                document.body.classList.add("page-organizations");
            } else if (activePage === "partners") {
                if (partnersSection) {
                    partnersSection.classList.add("page-visible");
                    partnersSection.classList.remove("page-hidden");
                }
                if (organizationsSection2) {
                    organizationsSection2.classList.add("page-hidden");
                    organizationsSection2.classList.remove("page-visible");
                }
                if (mainContent2) {
                    mainContent2.classList.add("page-hidden");
                    mainContent2.classList.remove("page-visible");
                }
                document.body.classList.remove("page-requests", "page-organizations");
                document.body.classList.add("page-partners");
            }
        }
        if (headerNav) headerNav.style.display = "flex";
        const headerAuthButtons = document.getElementById("headerAuthButtons");
        if (headerAuthButtons) {
            headerAuthButtons.style.display = "flex";
        }
        const searchField = document.querySelector(".header .search");
        if (header) {
            header.style.background = "#0066cc";
            header.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.1)";
            header.style.borderBottom = "1px solid #0052a3";
            header.style.position = "relative";
        }
    } else {
        document.body.classList.add("landing-page-active");
        document.body.classList.remove("page-requests", "page-organizations", "page-partners");
        document.body.classList.remove("authenticated");
        if (landingPage) landingPage.style.display = "block";
        const mainContent2 = document.getElementById("mainContent");
        const organizationsSection2 = document.getElementById("organizationsSection");
        const partnersSection = document.getElementById("partnersSection");
        if (mainContent2) {
            mainContent2.classList.add("page-hidden");
            mainContent2.classList.remove("page-visible");
        }
        if (organizationsSection2) {
            organizationsSection2.classList.add("page-hidden");
            organizationsSection2.classList.remove("page-visible");
        }
        if (partnersSection) {
            partnersSection.classList.add("page-hidden");
            partnersSection.classList.remove("page-visible");
        }
        if (headerNav) headerNav.style.display = "none";
        const headerAuthButtons = document.getElementById("headerAuthButtons");
        if (headerAuthButtons) headerAuthButtons.style.display = "none";
        if (header) {
            header.style.background = "transparent";
            header.style.boxShadow = "none";
            header.style.borderBottom = "none";
            header.style.position = "absolute";
            header.style.top = "0";
            header.style.left = "0";
            header.style.right = "0";
            header.style.zIndex = "100";
        }
    }
}

function showUserProfile() {
    try {
        const userData = localStorage.getItem("user");
        if (!userData) {
            const userHeaderInfo2 = document.getElementById("userHeaderInfo");
            const headerAuthButtons2 = document.getElementById("headerAuthButtons");
            const createBtn2 = document.getElementById("createRequestBtn");
            if (userHeaderInfo2 && headerAuthButtons2) {
                userHeaderInfo2.style.display = "none";
                headerAuthButtons2.style.display = "block";
            }
            if (createBtn2) {}
            return;
        }
        const user = JSON.parse(userData);
        const userSection = document.getElementById("userSection");
        const userHeaderInfo = document.getElementById("userHeaderInfo");
        const headerAuthButtons = document.getElementById("headerAuthButtons");
        if (userHeaderInfo && headerAuthButtons) {
            userHeaderInfo.style.display = "block";
            headerAuthButtons.style.display = "none";
            const fullName = user.full_name || "Пользователь";
            const firstName = fullName.split(" ")[0];
            const headerUserNameEl = document.getElementById("headerUserName");
            const headerUserFullNameEl = document.getElementById("headerUserFullName");
            if (headerUserNameEl) {
                headerUserNameEl.textContent = firstName;
            }
            if (headerUserFullNameEl) {
                headerUserFullNameEl.textContent = user.company_name || fullName;
            }
            const dropdownUserNameEl = document.getElementById("dropdownUserName");
            const dropdownUserRoleEl = document.getElementById("dropdownUserRole");
            if (dropdownUserNameEl) {
                dropdownUserNameEl.textContent = fullName;
            }
            if (dropdownUserRoleEl) {
                dropdownUserRoleEl.textContent = user.company_name ? `Перевозчик: ${user.company_name}` : "Пользователь";
            }
        }
        const createBtn = document.getElementById("createRequestBtn");
        if (createBtn) {}
        if (userSection) {
            document.getElementById("userFullName").textContent = user.full_name || "—";
            document.getElementById("userIIN").textContent = user.iin || "—";
            document.getElementById("userEmail").textContent = user.email || "—";
            document.getElementById("userCompany").textContent = user.company_name || "—";
            document.getElementById("userCertSerial").textContent = user.cert_serial || "—";
            document.getElementById("userCertIssuer").textContent = user.cert_issuer || "—";
            if (user.cert_valid_to) {
                document.getElementById("userCertValidTo").textContent = new Date(user.cert_valid_to).toLocaleDateString("ru-RU");
            }
            if (user.last_login) {
                document.getElementById("userLastLogin").textContent = new Date(user.last_login).toLocaleString("ru-RU");
            }
            const egovSection = document.getElementById("egovCompanySection");
            if (egovSection) {
                egovSection.style.display = "block";
            }
            const openPaymentDetails = localStorage.getItem("openPaymentDetailsModal");
            if (openPaymentDetails === "true") {
                localStorage.removeItem("openPaymentDetailsModal");
                localStorage.removeItem("returnToPaymentDetails");
                setTimeout(async () => {
                    try {
                        const apiUrl = typeof API_URL !== "undefined" ? API_URL : "https://cargoplatform.onrender.com";
                        const userResponse = await fetch(`${apiUrl}/api/users/${user.id}`, {
                            headers: {
                                "X-User-Id": user.id.toString()
                            }
                        });
                        if (userResponse.ok) {
                            const updatedUser = await userResponse.json();
                            localStorage.setItem("user", JSON.stringify(updatedUser));
                        }
                    } catch (e) {
                        console.warn("Не удалось обновить данные пользователя:", e);
                    }
                    if (window.openPaymentDetailsModal) {
                        window.openPaymentDetailsModal();
                    }
                }, 800);
            }
        }
        const logoutMenuItem = document.getElementById("logoutMenuItem");
        if (logoutMenuItem) {
            logoutMenuItem.addEventListener("click", e => {
                e.preventDefault();
                openLogoutConfirmModal();
            });
        }
        const userProfileTrigger = document.getElementById("userProfileTrigger");
        const userProfileDropdown = document.getElementById("userProfileDropdown");
        if (userProfileTrigger && userProfileDropdown) {
            userProfileTrigger.addEventListener("click", e => {
                e.stopPropagation();
                const isOpen = userProfileDropdown.style.display === "block";
                userProfileDropdown.style.display = isOpen ? "none" : "block";
            });
            document.addEventListener("click", e => {
                if (!userProfileTrigger.contains(e.target) && !userProfileDropdown.contains(e.target)) {
                    userProfileDropdown.style.display = "none";
                }
            });
        }
    } catch (error) {
        console.error("Ошибка при отображении профиля:", error);
    }
}

function openLogoutConfirmModal() {
    const modal = document.getElementById("logoutConfirmModal");
    if (modal) {
        modal.style.display = "flex";
        if (typeof lockBodyScroll === "function") {
            lockBodyScroll();
        }
    }
}

function closeLogoutConfirmModal() {
    const modal = document.getElementById("logoutConfirmModal");
    if (modal) {
        modal.style.display = "none";
        if (typeof unlockBodyScroll === "function") {
            unlockBodyScroll();
        }
    }
}

function performLogout() {
    localStorage.removeItem("user");
    localStorage.removeItem("isAuthenticated");
    closeLogoutConfirmModal();
    if (typeof showSuccess === "function") {
        showSuccess("Вы успешно вышли из системы");
    }
    setTimeout(() => {
        if (typeof navigateWithTransition === "function") {
            navigateWithTransition("index.html");
        } else {
            window.location.href = "index.html";
        }
    }, 300);
}

document.addEventListener("DOMContentLoaded", () => {
    toggleLandingPage();
    showUserProfile();
    checkServerStatus();
    setInterval(checkServerStatus, 3e4);
    const confirmLogoutBtn = document.getElementById("confirmLogoutBtn");
    if (confirmLogoutBtn) {
        confirmLogoutBtn.addEventListener("click", performLogout);
    }
});