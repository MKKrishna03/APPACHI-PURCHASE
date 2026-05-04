/* ═══════════════════════════════════════════════════════════════
   polish.js — Global interactive polish layer for Appachi
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── TOAST SYSTEM ──
  // Works alongside any existing showToast / showMessage on the page.
  // Other modules can call window._toast(msg, type) for a polished notification.
  function getOrCreateToastWrap() {
    let w = document.getElementById('polish-toast-wrap');
    if (!w) {
      w = document.createElement('div');
      w.id = 'polish-toast-wrap';
      document.body.appendChild(w);
    }
    return w;
  }

  window._toast = function (msg, type, duration) {
    type = type || 'default';
    duration = duration != null ? duration : 3200;
    const wrap = getOrCreateToastWrap();
    const t = document.createElement('div');
    t.className = 'polish-toast ' + type;
    t.textContent = msg;
    wrap.appendChild(t);
    // Force reflow then show
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { t.classList.add('show'); });
    });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, duration);
  };

  // ── SESSION EXPIRY WARNING ──
  function checkSessionExpiry() {
    try {
      var exp = parseInt(localStorage.getItem('auth_exp') || '0', 10);
      if (!exp) return;
      var remaining = exp - Date.now();
      var WARN_AT = 5 * 60 * 1000; // warn when < 5 min left
      if (remaining <= 0) return; // login redirect handled elsewhere
      if (remaining > WARN_AT) {
        // reschedule when we get close
        var nextCheck = Math.min(remaining - WARN_AT + 2000, 2 * 60 * 1000);
        setTimeout(checkSessionExpiry, nextCheck);
        return;
      }
      var mins = Math.ceil(remaining / 60000);
      var banner = document.getElementById('session-expiry-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'session-expiry-banner';
        document.body.prepend(banner);
      }
      banner.innerHTML =
        '⚠ Your session expires in ' + mins + ' minute' + (mins !== 1 ? 's' : '') +
        ' — save your work before it logs you out.' +
        ' <button onclick="this.parentElement.classList.remove(\'show\')">Dismiss</button>';
      banner.classList.add('show');
      // Re-check every minute to update the countdown
      setTimeout(checkSessionExpiry, 60000);
    } catch (e) {}
  }

  // ── BUTTON RIPPLE ──
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button, .btn, .camera-btn, .upload-btn, .retake-btn, .folder-card');
    if (!btn || btn.disabled) return;
    // Skip buttons that have external badges (overflow:hidden would clip them)
    if (btn.classList.contains('bell-btn') || btn.classList.contains('logoutButton') ||
        btn.classList.contains('toggle-btn') || btn.classList.contains('lightbox-close')) return;

    // Create ripple span
    var ripple = document.createElement('span');
    ripple.className = 'ripple-wave';

    var rect = btn.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height) * 1.6;
    var x = e.clientX - rect.left - size / 2;
    var y = e.clientY - rect.top - size / 2;

    ripple.style.cssText =
      'width:' + size + 'px;height:' + size + 'px;left:' + x + 'px;top:' + y + 'px;';

    // Ensure button has relative positioning + overflow hidden (polish.css already does this,
    // but belt-and-suspenders for elements not covered)
    var cs = getComputedStyle(btn);
    if (cs.position === 'static') btn.style.position = 'relative';
    if (cs.overflow === 'visible') btn.style.overflow = 'hidden';

    btn.appendChild(ripple);
    setTimeout(function () {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 650);
  }, true);

  // ── SCROLL-REVEAL TABLE ROWS ──
  function initScrollReveal() {
    if (!window.IntersectionObserver) return;

    var rows = document.querySelectorAll('tbody tr:not(.subtotal-row):not(.tfoot-row)');
    if (!rows.length) return;

    var delay = 0;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var row = entry.target;
        setTimeout(function () {
          row.classList.add('revealed');
        }, row._revealDelay || 0);
        observer.unobserve(row);
      });
    }, { rootMargin: '0px 0px -10px 0px', threshold: 0.05 });

    rows.forEach(function (row, i) {
      row.classList.add('reveal-row');
      row._revealDelay = Math.min(i * 18, 240);
      observer.observe(row);
    });
  }

  // ── STICKY THEAD SHADOW ──
  function initStickyTheadShadow() {
    var tables = document.querySelectorAll('table');
    tables.forEach(function (table) {
      var thead = table.querySelector('thead');
      if (!thead) return;

      // Find the scrollable ancestor
      var el = table.parentElement;
      var scroller = null;
      while (el && el !== document.body) {
        var overflow = getComputedStyle(el).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') { scroller = el; break; }
        el = el.parentElement;
      }
      var target = scroller || window;

      function onScroll() {
        var scrollTop = scroller ? scroller.scrollTop : window.scrollY;
        table.classList.toggle('thead-shadow', scrollTop > 8);
      }
      target.addEventListener('scroll', onScroll, { passive: true });
    });
  }

  // ── DIRTY FORM CHECK ──
  function initDirtyFormCheck() {
    var dirty = false;
    var watchables = document.querySelectorAll('[data-dirty-check] input, [data-dirty-check] select, [data-dirty-check] textarea');
    if (!watchables.length) return;

    watchables.forEach(function (el) {
      el.addEventListener('input', function () { dirty = true; });
      el.addEventListener('change', function () { dirty = true; });
    });

    window.addEventListener('beforeunload', function (e) {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Pages call this after a successful save
    window._markFormClean = function () { dirty = false; };
  }

  // ── COUNT-UP ANIMATION ──
  // Usage: _countUp(element, targetNumber, optionalDurationMs)
  window._countUp = function (el, end, duration) {
    if (!el) return;
    duration = duration || 900;
    var start = 0;
    var startTime = null;
    var isFloat = String(end).indexOf('.') !== -1;

    function step(ts) {
      if (!startTime) startTime = ts;
      var elapsed = ts - startTime;
      var progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = start + (end - start) * eased;

      if (isFloat) {
        el.textContent = current.toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      } else {
        el.textContent = Math.round(current).toLocaleString('en-IN');
      }

      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  };

  // ── LAST SAVED CHIP ──
  // Usage: _showLastSaved(anchorElement)  — inserts chip after anchorElement
  window._showLastSaved = function (anchor) {
    if (!anchor) return;
    // Remove any existing chip
    var prev = anchor.parentNode && anchor.parentNode.querySelector('.last-saved-chip');
    if (prev) prev.parentNode.removeChild(prev);

    var chip = document.createElement('span');
    chip.className = 'last-saved-chip';
    var now = new Date();
    var h = String(now.getHours()).padStart(2, '0');
    var m = String(now.getMinutes()).padStart(2, '0');
    chip.textContent = '✓ Saved ' + h + ':' + m;
    anchor.parentNode.insertBefore(chip, anchor.nextSibling);

    // Fade out after 8 seconds
    setTimeout(function () {
      chip.style.transition = 'opacity 0.5s ease';
      chip.style.opacity = '0';
      setTimeout(function () { if (chip.parentNode) chip.parentNode.removeChild(chip); }, 600);
    }, 8000);
  };

  // ── INIT ──
  function init() {
    checkSessionExpiry();
    initDirtyFormCheck();
    // Defer visual inits until after the page has rendered its content
    setTimeout(function () {
      initScrollReveal();
      initStickyTheadShadow();
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
