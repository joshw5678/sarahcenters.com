/* Tartarian Chronicles — carousel showcase + scoped theme switching */
(() => {
  "use strict";

  const ORDER = ["through", "refuge", "darkness", "brotherhood", "silver"];
  const BOOKS = {
    through: {
      number: "1",
      title: "Through the Veil",
      tagline: "The hidden past will not stay buried.",
      desc: "In a world shaped by ancient lines of power and long-buried truths, one young man discovers he is more than he was told. His journey will uncover secrets that could change everything.",
      themeColor: "#1b5891",
    },
    refuge: {
      number: "2",
      title: "The Refuge",
      tagline: "Some secrets are worth fighting for.",
      desc: "Aric and his allies find shelter in a hidden stronghold, but safety comes at a cost. As old enemies close in and buried truths rise to the surface, the fight for freedom becomes more dangerous than ever.",
      themeColor: "#77090c",
    },
    darkness: {
      number: "3",
      title: "Out of Darkness",
      tagline: "Some secrets are meant to stay buried.",
      desc: "As the shadows of the past rise, the truth becomes more dangerous than the lies. He was never meant to lead. Now he must. The fight for freedom begins where the light ends.",
      themeColor: "#000000",
    },
    brotherhood: {
      number: "4",
      title: "Brotherhood",
      tagline: "Bonds forged in truth. Loyalties tested by fire.",
      desc: "In a world where ancient power stirs and empires collide, loyalty is the sharpest weapon—and brotherhood is the only thing worth fighting for.",
      themeColor: "#012257",
    },
    silver: {
      number: "5",
      title: "Silver Light",
      tagline: "The light remembers. The future answers.",
      desc: "A long-hidden truth comes to light. As ancient forces awaken, hope becomes the final key to a future worth fighting for.",
      themeColor: "#0284c0",
    },
  };

  const copy = document.querySelector(".hero__copy");
  const stage = document.querySelector(".carousel__stage");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const carButtons = [...document.querySelectorAll("[data-car-book]")];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let index = Math.max(0, ORDER.indexOf(document.body.dataset.book));
  let swapTimer = 0;
  let enterTimer = 0;

  // Assign each cover its carousel slot (-2 … 2) relative to the selection.
  function layoutCarousel() {
    carButtons.forEach((btn) => {
      const i = ORDER.indexOf(btn.dataset.carBook);
      let off = (((i - index) % 5) + 5) % 5;
      if (off > 2) off -= 5;
      btn.dataset.pos = off;
      btn.setAttribute("aria-pressed", String(off === 0));
    });
  }

  function applyContent(slug) {
    const book = BOOKS[slug];
    for (const [field, value] of Object.entries(book)) {
      const el = copy.querySelector(`[data-field="${field}"]`);
      if (el) el.textContent = value;
    }
  }

  function switchBook(slug) {
    if (slug === ORDER[index] || !BOOKS[slug]) return;
    index = ORDER.indexOf(slug);

    document.body.dataset.book = slug;
    if (themeMeta) themeMeta.content = BOOKS[slug].themeColor;
    layoutCarousel();

    if (reduceMotion.matches) {
      applyContent(slug);
      return;
    }

    // Interruptible: a new click restarts the leave/enter choreography.
    clearTimeout(swapTimer);
    clearTimeout(enterTimer);
    copy.classList.remove("is-entering");
    copy.classList.add("is-leaving");
    swapTimer = setTimeout(() => {
      applyContent(slug);
      copy.classList.remove("is-leaving");
      copy.classList.add("is-entering");
      enterTimer = setTimeout(() => copy.classList.remove("is-entering"), 850);
    }, 330);
  }

  const step = (dir) => switchBook(ORDER[(index + dir + 5) % 5]);

  carButtons.forEach((btn) =>
    btn.addEventListener("click", () => switchBook(btn.dataset.carBook))
  );
  document.querySelector(".car-nav--prev").addEventListener("click", () => step(-1));
  document.querySelector(".car-nav--next").addEventListener("click", () => step(1));

  // Arrow keys rotate the carousel while focus is inside it.
  document.querySelector(".carousel").addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  });

  // Horizontal swipe on the stage.
  let touchX = null;
  stage.addEventListener("pointerdown", (event) => { touchX = event.clientX; });
  stage.addEventListener("pointerup", (event) => {
    if (touchX === null) return;
    const dx = event.clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  });

  layoutCarousel();

  // Load the non-active backdrop images once the page is idle,
  // so theme switches crossfade instantly without a fetch.
  const hydrateBackdrops = () => {
    const narrow = window.matchMedia("(max-width: 900px)").matches;
    document.querySelectorAll(".backdrop .bg").forEach((img) => {
      const want = (narrow && img.dataset.srcTall) || img.dataset.src || img.getAttribute("src");
      if (want && img.getAttribute("src") !== want) img.src = want;
      img.removeAttribute("data-src");
    });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(hydrateBackdrops, { timeout: 2500 });
  else setTimeout(hydrateBackdrops, 1200);

  // Raster kick: some compositors skip rasterizing freshly loaded images
  // inside 3D-transformed layers until something invalidates the frame.
  const kick = () => {
    stage.style.transform = "translateZ(0)";
    requestAnimationFrame(() => { stage.style.transform = ""; });
  };
  window.addEventListener("load", () => {
    requestAnimationFrame(kick);
    setTimeout(kick, 600);
    setTimeout(kick, 1800);
  });

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
