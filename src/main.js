/* Tartarian Chronicles — book showcase switching */
(() => {
  "use strict";

  const BOOKS = {
    through: {
      number: "1",
      title: "Through the Veil",
      tagline: "The hidden past will not stay buried.",
      desc: "In a world shaped by ancient lines of power and long-buried truths, one young man discovers he is more than he was told. His journey will uncover secrets that could change everything.",
      themeColor: "#1c4d9c",
    },
    refuge: {
      number: "2",
      title: "The Refuge",
      tagline: "Some secrets are worth fighting for.",
      desc: "Aric and his allies find shelter in a hidden stronghold, but safety comes at a cost. As old enemies close in and buried truths rise to the surface, the fight for freedom becomes more dangerous than ever.",
      themeColor: "#691110",
    },
    darkness: {
      number: "3",
      title: "Out of Darkness",
      tagline: "Some secrets are meant to stay buried.",
      desc: "As the shadows of the past rise, the truth becomes more dangerous than the lies. He was never meant to lead. Now he must. The fight for freedom begins where the light ends.",
      themeColor: "#0e0b0a",
    },
    brotherhood: {
      number: "4",
      title: "Brotherhood",
      tagline: "Bonds forged in truth. Loyalties tested by fire.",
      desc: "In a world where ancient power stirs and empires collide, loyalty is the sharpest weapon—and brotherhood is the only thing worth fighting for.",
      themeColor: "#16294f",
    },
    silver: {
      number: "5",
      title: "Silver Light",
      tagline: "The light remembers. The future answers.",
      desc: "A long-hidden truth comes to light. As ancient forces awaken, hope becomes the final key to a future worth fighting for.",
      themeColor: "#0c6dad",
    },
  };
  const heroSrc = (slug) => `images/opt/${slug}-hero.jpg`;

  const copy = document.querySelector(".hero__copy");
  const stack = document.querySelector(".book3d__stack");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const railButtons = [...document.querySelectorAll("[data-book-btn]")];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let current = document.body.dataset.book;
  let swapTimer = 0;
  let enterTimer = 0;
  let coverToken = 0;

  function applyContent(slug) {
    const book = BOOKS[slug];
    for (const [field, value] of Object.entries(book)) {
      const el = copy.querySelector(`[data-field="${field}"]`);
      if (el) el.textContent = value;
    }
  }

  function crossfadeCover(slug, instant) {
    const token = ++coverToken;
    const front = stack.querySelector(".cover.is-active");
    const back = stack.querySelector(".cover:not(.is-active)");
    back.src = heroSrc(slug);
    back.alt = `${BOOKS[slug].title} — Tartarian Chronicles Book ${BOOKS[slug].number}, by S.E. Centers`;
    const swap = () => {
      if (token !== coverToken) return; // superseded by a newer switch
      const duration = instant ? "0s" : "";
      back.style.transitionDuration = duration;
      front.style.transitionDuration = duration;
      back.classList.add("is-active");
      front.classList.remove("is-active");
      front.alt = "";
    };
    if (back.decode) back.decode().then(swap).catch(swap);
    else if (back.complete) swap();
    else back.onload = swap;
  }

  function switchBook(slug) {
    if (slug === current || !BOOKS[slug]) return;
    current = slug;

    document.body.dataset.book = slug;
    if (themeMeta) themeMeta.content = BOOKS[slug].themeColor;
    railButtons.forEach((btn) =>
      btn.setAttribute("aria-pressed", String(btn.dataset.bookBtn === slug))
    );

    // If the showcase is out of view, bring it back so the change is seen.
    const hero = document.querySelector(".hero");
    if (hero.getBoundingClientRect().bottom < 140) {
      hero.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth" });
    }

    if (reduceMotion.matches) {
      applyContent(slug);
      crossfadeCover(slug, true);
      return;
    }

    // Interruptible: a new click restarts the leave/enter choreography.
    clearTimeout(swapTimer);
    clearTimeout(enterTimer);
    copy.classList.remove("is-entering");
    copy.classList.add("is-leaving");
    crossfadeCover(slug, false);
    swapTimer = setTimeout(() => {
      applyContent(slug);
      copy.classList.remove("is-leaving");
      copy.classList.add("is-entering");
      enterTimer = setTimeout(() => copy.classList.remove("is-entering"), 850);
    }, 330);
  }

  railButtons.forEach((btn) =>
    btn.addEventListener("click", () => switchBook(btn.dataset.bookBtn))
  );

  // Warm the cache for the other covers once the page is idle,
  // so every switch crossfades instantly.
  const preload = () => {
    Object.keys(BOOKS)
      .filter((slug) => slug !== current)
      .forEach((slug) => {
        new Image().src = heroSrc(slug);
      });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(preload, { timeout: 2500 });
  else setTimeout(preload, 1200);

  // Newsletter — friendly inline confirmation (no backend wired up yet).
  const form = document.querySelector(".newsletter__form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = form.querySelector("input[type=email]");
    if (!email.checkValidity()) {
      email.reportValidity();
      return;
    }
    const confirm = document.createElement("p");
    confirm.className = "newsletter__confirm";
    confirm.setAttribute("role", "status");
    confirm.textContent = "Welcome to the journey — you're on the list.";
    form.replaceWith(confirm);
  });
})();
