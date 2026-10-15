import { scalarText } from "../shared/contracts.js";
import { AppError, errorMessage, isRecord, parseJson, cartItemSchema, booksResponseSchema, accountResponseSchema, contentResponseSchema, checkoutResponseSchema } from "../shared/contracts.js";
import type { Book, CartItem, AccountUser, SiteContent } from "../shared/contracts.js";
import { element, optionalElement, requestJson } from "./browser.js";
interface HeroBook { number: string; title: string; tagline: string; desc: string; themeColor: string; image: string; priceCents: number; currency: string }
/* Tartarian Chronicles - carousel showcase, cart, and checkout */
(() => {
  "use strict";

  const ORDER = ["through", "refuge", "darkness", "brotherhood", "silver"];
  const PDF_ADDON_CENTS = 100;
  const HERO_BOOKS: Record<string, HeroBook> = {
    through: {
      number: "1",
      title: "Through the Veil",
      tagline: "The hidden past will not stay buried.",
      desc: "Step into Chris and Tina's shoes as they uncover secrets of their ancestors, discover a hidden realm, face ghosts of the past and confront demons of the present.",
      themeColor: "#1b5891",
      image: "images/opt/through-thumb.jpg",
      priceCents: 399,
      currency: "usd",
    },
    refuge: {
      number: "2",
      title: "The Refuge",
      tagline: "Some secrets are worth fighting for.",
      desc: "Aric and his allies find shelter in a hidden stronghold, but safety comes at a cost. As old enemies close in and buried truths rise to the surface, the fight for freedom becomes more dangerous than ever.",
      themeColor: "#77090c",
      image: "images/opt/refuge-thumb.jpg",
      priceCents: 399,
      currency: "usd",
    },
    darkness: {
      number: "3",
      title: "Out of Darkness",
      tagline: "Some secrets are meant to stay buried.",
      desc: "As the shadows of the past rise, the truth becomes more dangerous than the lies. He was never meant to lead. Now he must. The fight for freedom begins where the light ends.",
      themeColor: "#000000",
      image: "images/opt/darkness-thumb.jpg",
      priceCents: 499,
      currency: "usd",
    },
    brotherhood: {
      number: "4",
      title: "Brotherhood",
      tagline: "Bonds forged in truth. Loyalties tested by fire.",
      desc: "In a world where ancient power stirs and empires collide, loyalty is the sharpest weapon-and brotherhood is the only thing worth fighting for.",
      themeColor: "#012257",
      image: "images/opt/brotherhood-thumb.jpg",
      priceCents: 599,
      currency: "usd",
    },
    silver: {
      number: "5",
      title: "Silver Light",
      tagline: "The light remembers. The future answers.",
      desc: "A long-hidden truth comes to light. As ancient forces awaken, hope becomes the final key to a future worth fighting for.",
      themeColor: "#0284c0",
      image: "images/opt/silver-thumb.jpg",
      priceCents: 599,
      currency: "usd",
    },
  };
  function heroBook(slug: string): HeroBook { const book = HERO_BOOKS[slug]; if (!book) throw new Error("Unknown featured book."); return book; }
  const FALLBACK_BOOKS: Book[] = ORDER.map((id) => ({ id, slug: id, active: true, ...heroBook(id) }));
  const CART_KEY = "tc_cart";

  const copy = element(".hero__copy", HTMLElement);
  const stage = element(".carousel__stage", HTMLElement);
  const scenes: Record<string, HTMLElement> = {};
  document.querySelectorAll(".backdrop .scene").forEach((el) => {
    if (el instanceof HTMLElement && el.dataset.scene) scenes[el.dataset.scene] = el;
  });
  const themeMeta = optionalElement('meta[name="theme-color"]', HTMLMetaElement);
  const carButtons = [...document.querySelectorAll("[data-car-book]")].filter((button): button is HTMLButtonElement => button instanceof HTMLButtonElement);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const rail = optionalElement("[data-books-rail]", HTMLElement);
  const cartPanel = optionalElement("[data-cart-panel]", HTMLElement);
  const cartBackdrop = optionalElement("[data-cart-backdrop]", HTMLElement);
  const cartItems = optionalElement("[data-cart-items]", HTMLElement);
  const cartEmpty = optionalElement("[data-cart-empty]", HTMLElement);
  const cartSubtotal = optionalElement("[data-cart-subtotal]", HTMLElement);
  const cartCount = optionalElement("[data-cart-count]", HTMLElement);
  const checkoutButton = optionalElement("[data-checkout]", HTMLButtonElement);
  const toast = optionalElement("[data-toast]", HTMLElement);
  const accountLink = optionalElement("[data-account-link]", HTMLAnchorElement);

  let index = Math.max(0, ORDER.indexOf(document.body.dataset.book || "silver"));
  let swapTimer = 0;
  let enterTimer = 0;
  let catalog: Book[] = [...FALLBACK_BOOKS];
  let apiCatalogLoaded = false;
  let cart = loadCart();
  let toastTimer = 0;
  let account: AccountUser | null = null;
  let csrfToken = "";
  let accountPromise: Promise<void> | null = null;
  let siteContent: SiteContent = {};

  function layoutCarousel() {
    carButtons.forEach((btn) => {
      const i = ORDER.indexOf(btn.dataset.carBook || "");
      let off = (((i - index) % 5) + 5) % 5;
      if (off > 2) off -= 5;
      btn.dataset.pos = scalarText(off);
      btn.setAttribute("aria-pressed", scalarText(off === 0));
    });
  }

  function applyContent(slug: string) {
    const book = heroBook(slug);
    (["number", "title", "tagline", "desc"] as const).forEach((field) => {
      const el = copy.querySelector(`[data-field="${field}"]`);
      if (el) el.textContent = book[field];
    });
  }

  function switchBook(slug: string | undefined) {
    if (!slug || slug === ORDER[index] || !HERO_BOOKS[slug]) return;
    index = ORDER.indexOf(slug);

    document.body.dataset.book = slug;
    if (themeMeta) themeMeta.content = heroBook(slug).themeColor;
    Object.values(scenes).forEach((scene) => scene.classList.remove("is-active"));
    scenes[slug]?.classList.add("is-active");
    layoutCarousel();

    if (reduceMotion.matches) {
      applyContent(slug);
      return;
    }

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

  const step = (dir: number) => switchBook(ORDER[(index + dir + 5) % 5]);

  function loadCart(): CartItem[] {
    try {
      const parsed: unknown = parseJson(localStorage.getItem(CART_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      const entries: unknown[] = parsed;
      return entries.flatMap((item): CartItem[] => {
        if (!isRecord(item)) return [];
        const result = cartItemSchema.safeParse({
          bookId: scalarText(item.bookId || ""),
          quantity: Math.max(1, Math.min(99, Math.floor(Number(item.quantity || 1)))),
          includePdf: item.includePdf === true || item.format === "epub_pdf" || item.formats === "epub_pdf" || (Array.isArray(item.formats) && item.formats.includes("pdf")),
        });
        return result.success && result.data.bookId ? [result.data] : [];
      });
    } catch { return []; }
  }

  function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }

  function formatMoney(cents: number, currency = "usd") {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: scalarText(currency || "usd").toUpperCase(),
      }).format((Number(cents) || 0) / 100);
    } catch {
      return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
    }
  }

  function findBook(bookId: string) {
    const fromApi = catalog.find((book) => book.id === bookId && book.active !== false);
    if (fromApi) return fromApi;
    return apiCatalogLoaded ? null : FALLBACK_BOOKS.find((book) => book.id === bookId);
  }

  function itemUnitCents(book: Book | undefined | null, item: CartItem) {
    return (Number(book?.priceCents) || 0) + (item?.includePdf ? PDF_ADDON_CENTS : 0);
  }

  function formatLabel(item: CartItem) {
    return item?.includePdf ? "EPUB + PDF" : "EPUB";
  }

  function showToast(message: string) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function openCart() {
    if (!cartPanel || !cartBackdrop) return;
    document.body.classList.add("cart-open");
    cartBackdrop.hidden = false;
    cartPanel.setAttribute("aria-hidden", "false");
  }

  function closeCart() {
    if (!cartPanel || !cartBackdrop) return;
    document.body.classList.remove("cart-open");
    cartBackdrop.hidden = true;
    cartPanel.setAttribute("aria-hidden", "true");
  }

  function addToCart(bookId: string | undefined, quantity = 1) {
    const book = bookId ? findBook(bookId) : null;
    if (!book) {
      showToast("That book is not available right now.");
      return;
    }

    const existing = cart.find((item) => item.bookId === bookId);
    if (existing) existing.quantity = Math.min(99, existing.quantity + quantity);
    else cart.push({ bookId: book.id, quantity, includePdf: false });
    saveCart();
    renderCart();
    openCart();
    showToast(`${book.title} added to cart.`);
  }

  function updateCartQuantity(bookId: string, quantity: number) {
    cart = cart
      .map((item) =>
        item.bookId === bookId
          ? { ...item, quantity: Math.max(0, Math.min(99, quantity)) }
          : item
      )
      .filter((item) => item.quantity > 0);
    saveCart();
    renderCart();
  }

  function removeFromCart(bookId: string) {
    cart = cart.filter((item) => item.bookId !== bookId);
    saveCart();
    renderCart();
  }

  function updateCartFormat(bookId: string, includePdf: boolean) {
    cart = cart.map((item) =>
      item.bookId === bookId ? { ...item, includePdf: Boolean(includePdf) } : item
    );
    saveCart();
    renderCart();
  }

  function renderBookRail(books: Book[]) {
    if (!rail) return;
    rail.replaceChildren();

    books.forEach((book) => {
      const li = document.createElement("li");
      li.className = "rail__book";
      li.dataset.bookId = book.id;

      const img = document.createElement("img");
      img.src = book.image;
      img.width = 340;
      img.height = 541;
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = book.number ? `${book.title} - Book ${book.number}` : book.title;

      const caption = document.createElement("span");
      caption.className = "rail__caption";
      caption.textContent = book.number ? `Book ${book.number}` : "New Release";

      const title = document.createElement("strong");
      title.className = "rail__title";
      title.textContent = book.title;

      const price = document.createElement("span");
      price.className = "rail__price";
      price.textContent = `${formatMoney(book.priceCents, book.currency)} ${scalarText(
        book.currency || "usd"
      ).toUpperCase()}`;

      const button = document.createElement("button");
      button.className = "btn btn--solid btn--sm rail__cart";
      button.type = "button";
      button.dataset.addToCart = book.id;
      button.textContent = "Add to Cart";

      li.append(img, caption, title, price, button);
      rail.append(li);
    });
  }

  function renderCart() {
    if (!cartItems || !cartEmpty || !cartSubtotal || !cartCount || !checkoutButton) return;

    const availableItems = cart.filter((item) => findBook(item.bookId));
    if (availableItems.length !== cart.length) {
      cart = availableItems;
      saveCart();
    }

    cartItems.replaceChildren();
    let subtotal = 0;
    let count = 0;

    cart.forEach((item) => {
      const book = findBook(item.bookId);
      if (!book) return;
      const unitCents = itemUnitCents(book, item);
      subtotal += unitCents * item.quantity;
      count += item.quantity;

      const row = document.createElement("article");
      row.className = "cart-item";

      const img = document.createElement("img");
      img.src = book.image;
      img.alt = "";
      img.width = 58;
      img.height = 92;

      const body = document.createElement("div");
      body.className = "cart-item__body";

      const title = document.createElement("h3");
      title.textContent = book.title;

      const meta = document.createElement("p");
      meta.textContent = `${formatMoney(unitCents, book.currency)} each - ${formatLabel(item)}`;

      const format = document.createElement("label");
      format.className = "cart-item__format";
      const formatInput = document.createElement("input");
      formatInput.type = "checkbox";
      formatInput.dataset.cartPdf = item.bookId;
      formatInput.checked = Boolean(item.includePdf);
      const formatText = document.createElement("span");
      formatText.textContent = `Add PDF (+${formatMoney(PDF_ADDON_CENTS, book.currency)})`;
      format.append(formatInput, formatText);

      const controls = document.createElement("div");
      controls.className = "cart-item__controls";

      const dec = document.createElement("button");
      dec.className = "cart-qty";
      dec.type = "button";
      dec.dataset.cartDec = item.bookId;
      dec.setAttribute("aria-label", `Decrease quantity for ${book.title}`);
      dec.textContent = "-";

      const qty = document.createElement("span");
      qty.className = "cart-item__qty";
      qty.textContent = scalarText(item.quantity);

      const inc = document.createElement("button");
      inc.className = "cart-qty";
      inc.type = "button";
      inc.dataset.cartInc = item.bookId;
      inc.setAttribute("aria-label", `Increase quantity for ${book.title}`);
      inc.textContent = "+";

      const remove = document.createElement("button");
      remove.className = "icon-button icon-button--plain";
      remove.type = "button";
      remove.dataset.cartRemove = item.bookId;
      remove.setAttribute("aria-label", `Remove ${book.title} from cart`);
      remove.innerHTML = '<svg width="18" height="18" aria-hidden="true"><use href="#i-trash"/></svg>';

      controls.append(dec, qty, inc, remove);
      body.append(title, meta, format, controls);
      row.append(img, body);
      cartItems.append(row);
    });

    cartEmpty.hidden = cart.length > 0;
    checkoutButton.disabled = cart.length === 0;
    cartSubtotal.textContent = formatMoney(subtotal, cart[0] ? findBook(cart[0]?.bookId || "")?.currency : "usd");
    cartCount.textContent = scalarText(count);
    cartCount.hidden = count === 0;
  }

  async function hydrateBooks() {
    renderBookRail(catalog);
    renderCart();

    try {
      const response = await fetch("/api/books", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Unable to load books.");
      const data = booksResponseSchema.parse(await response.json());
      if (Array.isArray(data.books) && data.books.length > 0) {
        catalog = data.books;
        apiCatalogLoaded = true;
        renderBookRail(catalog);
        renderCart();
      }
    } catch {
      apiCatalogLoaded = false;
    }
  }

  async function checkout() {
    if (cart.length === 0 || !checkoutButton) return;
    if (accountPromise) await accountPromise;
    if (!account) {
      window.location.assign(`/login.html?return=${encodeURIComponent("/?checkout=resume")}`);
      return;
    }
    if (!account.emailVerified) {
      window.location.assign(
        `/verify-email.html?return=${encodeURIComponent("/?checkout=resume")}`
      );
      return;
    }
    const originalText = checkoutButton.textContent;
    checkoutButton.disabled = true;
    checkoutButton.textContent = "Opening Checkout...";

    try {
      const data = await requestJson("/api/checkout/session", checkoutResponseSchema, {
        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ items: cart }),
      });
      window.location.assign(data.url);
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        window.location.assign(`/login.html?return=${encodeURIComponent("/?checkout=resume")}`);
        return;
      }
      if (error instanceof AppError && error.code === "EMAIL_VERIFICATION_REQUIRED") {
        window.location.assign(`/verify-email.html?return=${encodeURIComponent("/?checkout=resume")}`);
        return;
      }
      checkoutButton.disabled = cart.length === 0;
      checkoutButton.textContent = originalText;
      showToast(errorMessage(error, "Checkout could not start."));
    }
  }

  carButtons.forEach((btn) =>
    btn.addEventListener("click", () => switchBook(btn.dataset.carBook))
  );
  element(".car-nav--prev", HTMLButtonElement).addEventListener("click", () => step(-1));
  element(".car-nav--next", HTMLButtonElement).addEventListener("click", () => step(1));

  element(".carousel", HTMLElement).addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  });

  let touchX: number | null = null;
  stage.addEventListener("pointerdown", (event) => {
    touchX = event.clientX;
  });
  stage.addEventListener("pointerup", (event) => {
    if (touchX === null) return;
    const dx = event.clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const addButton = event.target.closest<HTMLButtonElement>("button[data-add-to-cart]");
    const incButton = event.target.closest<HTMLButtonElement>("button[data-cart-inc]");
    const decButton = event.target.closest<HTMLButtonElement>("button[data-cart-dec]");
    const removeButton = event.target.closest<HTMLButtonElement>("button[data-cart-remove]");

    if (addButton) addToCart(addButton.dataset.addToCart);
    if (incButton) {
      const item = cart.find((entry) => entry.bookId === incButton.dataset.cartInc);
      if (item) updateCartQuantity(item.bookId, item.quantity + 1);
    }
    if (decButton) {
      const item = cart.find((entry) => entry.bookId === decButton.dataset.cartDec);
      if (item) updateCartQuantity(item.bookId, item.quantity - 1);
    }
    if (removeButton) removeFromCart(removeButton.dataset.cartRemove || "");
  });

  document.addEventListener("change", (event) => {
    if (!(event.target instanceof Element)) return;
    const pdfToggle = event.target.closest<HTMLInputElement>("input[data-cart-pdf]");
    if (pdfToggle) updateCartFormat(pdfToggle.dataset.cartPdf || "", pdfToggle.checked);
  });

  document.querySelectorAll("[data-cart-open]").forEach((button) => {
    button.addEventListener("click", openCart);
  });
  document.querySelectorAll("[data-cart-close]").forEach((button) => {
    button.addEventListener("click", closeCart);
  });
  if (cartBackdrop) cartBackdrop.addEventListener("click", closeCart);
  if (checkoutButton) checkoutButton.addEventListener("click", checkout);
  element("[data-hero-order]", HTMLButtonElement).addEventListener("click", () => {
    addToCart(ORDER[index]);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCart();
  });

  function updateAccountLink() {
    if (!accountLink) return;
    if (account) {
      accountLink.textContent = "My Library";
      accountLink.href = "/library.html";
    } else {
      accountLink.textContent = siteContent["nav.login"] || "Log In";
      accountLink.href = "/login.html";
    }
  }

  function applySiteContent(content: SiteContent) {
    siteContent = content || {};

    document.querySelectorAll("[data-content]").forEach((el) => {
      if (el.hasAttribute("data-account-link")) return; // handled by updateAccountLink
      const value = siteContent[el.getAttribute("data-content") || ""];
      if (typeof value === "string" && value.length) el.textContent = value;
    });

    document.querySelectorAll("[data-content-placeholder]").forEach((el) => {
      const value = siteContent[el.getAttribute("data-content-placeholder") || ""];
      if (typeof value === "string" && value.length) el.setAttribute("placeholder", value);
    });

    if (siteContent["site.title"]) document.title = siteContent["site.title"];
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && siteContent["site.description"]) {
      metaDesc.setAttribute("content", siteContent["site.description"]);
    }

    updateAccountLink();
  }

  async function hydrateContent() {
    try {
      const response = await fetch("/api/content", { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = contentResponseSchema.parse(await response.json());
      if (data && data.content) applySiteContent(data.content);
    } catch {
      /* keep the HTML defaults */
    }
  }

  layoutCarousel();
  void hydrateContent();
  void hydrateBooks();

  async function hydrateAccount() {
    try {
      const response = await fetch("/api/account/me", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const data = accountResponseSchema.parse(await response.json());
      account = data.user;
      csrfToken = data.csrfToken;
    } catch {
      account = null;
      csrfToken = "";
    } finally {
      updateAccountLink();
    }
  }
  accountPromise = hydrateAccount();

  const hydrateBackdrops = () => {
    document.querySelectorAll(".backdrop img[data-src]").forEach((img) => {
      if (!(img instanceof HTMLImageElement) || !img.dataset.src) return;
      img.src = img.dataset.src;
      img.removeAttribute("data-src");
    });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(hydrateBackdrops, { timeout: 2500 });
  else setTimeout(hydrateBackdrops, 1200);

  const kick = () => {
    document.body.style.transform = "translateZ(0)";
    void document.body.offsetHeight;
    document.body.style.transform = "";
  };
  window.addEventListener("load", () => {
    requestAnimationFrame(kick);
    setTimeout(kick, 600);
    setTimeout(kick, 1800);
  });
  document.querySelectorAll(".car-book img, .backdrop img").forEach((img) => {
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.complete) img.addEventListener("load", () => requestAnimationFrame(kick), { once: true });
  });

  const form = element(".newsletter__form", HTMLFormElement);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const email = element("input[type=email]", HTMLInputElement, form);
    if (!email.checkValidity()) {
      email.reportValidity();
      return;
    }
    const confirm = document.createElement("p");
    confirm.className = "newsletter__confirm";
    confirm.setAttribute("role", "status");
    confirm.textContent =
      siteContent["newsletter.confirm"] || "Welcome to the journey - you're on the list.";
    form.replaceWith(confirm);
  });

  if (new URLSearchParams(window.location.search).get("checkout") === "cancelled") {
    showToast("Checkout was cancelled. Your cart is still here.");
    openCart();
  }
  if (new URLSearchParams(window.location.search).get("checkout") === "resume") {
    showToast("You are signed in. Review your cart, then continue to secure checkout.");
    openCart();
  }
})();
