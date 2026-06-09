(function() {
    "use strict";
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const TRANSITION_DURATION = prefersReducedMotion ? 0 : 300;
    const ENTER_DURATION = prefersReducedMotion ? 0 : 400;
    const preloadCache = new Set;
    function isInternalLink(href) {
        if (!href) return false;
        if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//") || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
            return false;
        }
        try {
            const url = new URL(href, window.location.origin);
            return url.origin === window.location.origin;
        } catch {
            return false;
        }
    }
    function preloadPage(url) {
        if (preloadCache.has(url) || prefersReducedMotion) return;
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = url;
        document.head.appendChild(link);
        preloadCache.add(url);
    }
    function handleLinkHover(e) {
        const href = e.currentTarget.getAttribute("href");
        if (isInternalLink(href)) {
            const url = new URL(href, window.location.origin).href;
            preloadPage(url);
        }
    }
    function handleLinkClick(e) {
        const link = e.target.closest("a[href]");
        if (!link) return;
        const href = link.getAttribute("href");
        if (!isInternalLink(href)) return;
        if (link.target === "_blank") return;
        if (e.ctrlKey || e.metaKey || e.button === 1) return;
        try {
            const url = new URL(href, window.location.origin);
            if (url.pathname === window.location.pathname && url.hash) {
                return;
            }
        } catch {
            return;
        }
        e.preventDefault();
        if (!prefersReducedMotion) {
            document.body.classList.add("page-exit");
        }
        const transitionDelay = prefersReducedMotion ? 0 : TRANSITION_DURATION;
        setTimeout(() => {
            window.location.href = href;
        }, transitionDelay);
    }
    function initPageEnter() {
        if (prefersReducedMotion) {
            document.body.classList.remove("page-loading");
            document.body.classList.add("page-loaded");
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.body.classList.remove("page-loading");
                document.body.classList.add("page-loaded");
            });
        });
    }
    function handlePopState() {
        if (prefersReducedMotion) {
            document.body.classList.remove("page-loaded");
            document.body.classList.add("page-loading");
            initPageEnter();
            return;
        }
        document.body.classList.remove("page-loaded");
        document.body.classList.add("page-loading");
        initPageEnter();
    }
    function init() {
        initPageEnter();
        document.addEventListener("click", handleLinkClick, true);
        let hoverTimeout;
        document.addEventListener("mouseover", e => {
            const link = e.target.closest("a[href]");
            if (!link) return;
            clearTimeout(hoverTimeout);
            hoverTimeout = setTimeout(() => {
                handleLinkHover({
                    currentTarget: link
                });
            }, 100);
        }, true);
        window.addEventListener("popstate", handlePopState);
        window.addEventListener("beforeunload", () => {
            document.body.classList.add("page-exit");
        });
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
    function navigateWithTransition(url) {
        if (!isInternalLink(url)) {
            window.location.href = url;
            return;
        }
        if (!prefersReducedMotion) {
            document.body.classList.add("page-exit");
        }
        setTimeout(() => {
            window.location.href = url;
        }, prefersReducedMotion ? 0 : TRANSITION_DURATION);
    }
    window.navigateWithTransition = navigateWithTransition;
})();