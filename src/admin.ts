import { scalarText } from "../shared/contracts.js";
import * as z from "zod";
import { errorMessage, bookSchema, orderSchema, contentSchema } from "../shared/contracts.js";
import type { Book, Order, OrderItem, Address, SiteContent } from "../shared/contracts.js";
import { element, optionalElement, input, requestJson } from "./browser.js";
(() => {
  "use strict";

  const loginPanel = element("[data-login-panel]", HTMLElement);
  const loginForm = element("[data-login-form]", HTMLFormElement);
  const loginMessage = element("[data-login-message]", HTMLElement);
  const app = element("[data-admin-app]", HTMLElement);
  const ordersList = element("[data-orders-list]", HTMLElement);
  const booksList = element("[data-books-list]", HTMLElement);
  const orderFilter = element("[data-order-filter]", HTMLSelectElement);
  const bookForm = element("[data-book-form]", HTMLFormElement);
  const bookMessage = optionalElement("[data-book-message]", HTMLElement);
  const contentForm = optionalElement("[data-content-form]", HTMLFormElement);
  const contentMessage = optionalElement("[data-content-message]", HTMLElement);
  const contentReload = optionalElement("[data-content-reload]", HTMLButtonElement);

  let orders: Order[] = [];
  let books: Book[] = [];

  const responseSchema = z.object({ ok: z.boolean().optional(), books: z.array(bookSchema).optional(), book: bookSchema.nullable().optional(), orders: z.array(orderSchema).optional(), order: orderSchema.nullable().optional(), content: contentSchema.optional() });
  function api(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    return requestJson(path, responseSchema, { ...options, headers });
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

  function formatDate(value: string | null | undefined) {
    if (!value) return "-";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function addressText(address: Address | null | undefined) {
    if (!address) return "";
    return [
      address.line1,
      address.line2,
      [address.city, address.state, address.postal_code].filter(Boolean).join(", "),
      address.country,
    ]
      .filter(Boolean)
      .join(" ");
  }

  function itemLabel(item: OrderItem) {
    const format =
      item.formatLabel ||
      (Array.isArray(item.formats) && item.formats.includes("pdf")
        ? "EPUB + PDF"
        : "EPUB");
    return `${item.title} (${format})`;
  }

  function setLoggedIn(isLoggedIn: boolean) {
    loginPanel.hidden = isLoggedIn;
    app.hidden = !isLoggedIn;
  }

  function badge(text: string | undefined) {
    const span = document.createElement("span");
    span.className = `admin-badge admin-badge--${scalarText(text || "unknown").toLowerCase()}`;
    span.textContent = text || "unknown";
    return span;
  }

  function field(labelText: string, value: string | undefined) {
    const row = document.createElement("p");
    row.className = "admin-field";
    const label = document.createElement("span");
    label.textContent = labelText;
    const strong = document.createElement("strong");
    strong.textContent = value || "-";
    row.append(label, strong);
    return row;
  }

  function renderOrders() {
    ordersList.replaceChildren();
    if (orders.length === 0) {
      const empty = document.createElement("p");
      empty.className = "admin-empty";
      empty.textContent = "No orders yet.";
      ordersList.append(empty);
      return;
    }

    orders.forEach((order) => {
      const card = document.createElement("article");
      card.className = "admin-card order-card";
      card.dataset.orderId = order.id;

      const head = document.createElement("div");
      head.className = "order-card__head";
      const title = document.createElement("div");
      const id = document.createElement("h3");
      id.textContent = order.id;
      const date = document.createElement("p");
      date.textContent = formatDate(order.createdAt);
      title.append(id, date);
      const badges = document.createElement("div");
      badges.className = "order-card__badges";
      badges.append(badge(order.status), badge(order.fulfillmentStatus));
      head.append(title, badges);

      const meta = document.createElement("div");
      meta.className = "order-card__meta";
      meta.append(
        field("Customer", order.customer?.name),
        field("Email", order.customer?.email),
        field("Delivery", "Digital ebook"),
        field("Billing", addressText(order.customer?.address)),
        field("Total", formatMoney(order.totalCents, order.currency)),
        field("Payment", order.paymentStatus)
      );

      const items = document.createElement("ul");
      items.className = "order-items";
      order.items.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = `${item.quantity} x ${itemLabel(item)} - ${formatMoney(item.unitAmountCents * item.quantity, item.currency)}`;
        items.append(li);
      });

      const controls = document.createElement("div");
      controls.className = "order-controls";
      controls.innerHTML = `
        <label>Fulfillment
          <select data-order-status>
            <option value="unpaid">Unpaid</option>
            <option value="new">New</option>
            <option value="delivered">Delivered</option>
            <option value="complete">Complete</option>
            <option value="canceled">Canceled</option>
          </select>
        </label>
        <label>Delivery Note
          <input data-order-tracking type="text" maxlength="160" placeholder="EPUB sent by email">
        </label>
        <label class="order-controls__wide">Owner Notes
          <textarea data-order-notes rows="3" maxlength="1200"></textarea>
        </label>
      `;
      const statusSelect = element("[data-order-status]", HTMLSelectElement, controls);
      if (
        order.fulfillmentStatus &&
        ![...statusSelect.options].some((option) => option.value === order.fulfillmentStatus)
      ) {
        const legacyOption = document.createElement("option");
        legacyOption.value = order.fulfillmentStatus;
        legacyOption.textContent = order.fulfillmentStatus;
        statusSelect.append(legacyOption);
      }
      statusSelect.value = order.fulfillmentStatus || "unpaid";
      element("[data-order-tracking]", HTMLInputElement, controls).value = order.trackingNumber || "";
      element("[data-order-notes]", HTMLTextAreaElement, controls).value = order.ownerNotes || "";

      const footer = document.createElement("div");
      footer.className = "order-card__footer";
      const receipt = document.createElement("a");
      receipt.className = "btn btn--outline btn--sm";
      receipt.textContent = "Stripe Receipt";
      receipt.href = order.receiptUrl || "#";
      receipt.toggleAttribute("hidden", !order.receiptUrl);
      const save = document.createElement("button");
      save.className = "btn btn--solid btn--sm";
      save.type = "button";
      save.dataset.saveOrder = order.id;
      save.textContent = "Save Order";
      footer.append(receipt, save);

      card.append(head, meta, items, controls, footer);
      ordersList.append(card);
    });
  }

  function renderBooks() {
    booksList.replaceChildren();
    if (books.length === 0) {
      const empty = document.createElement("p");
      empty.className = "admin-empty";
      empty.textContent = "No books in the catalog.";
      booksList.append(empty);
      return;
    }

    books.forEach((book) => {
      const card = document.createElement("article");
      card.className = "admin-card book-card";
      const img = document.createElement("img");
      img.src = book.image;
      img.alt = "";
      img.width = 58;
      img.height = 92;
      const body = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = book.title;
      const meta = document.createElement("p");
      meta.textContent = `${book.number ? `Book ${book.number} - ` : ""}${formatMoney(book.priceCents, book.currency)} EPUB`;
      body.append(title, meta, badge(book.active ? "active" : "hidden"));
      const button = document.createElement("button");
      button.className = book.active ? "btn btn--outline btn--sm" : "btn btn--solid btn--sm";
      button.type = "button";
      button.dataset.toggleBook = book.id;
      button.dataset.active = scalarText(book.active);
      button.textContent = book.active ? "Hide" : "Publish";
      card.append(img, body, button);
      booksList.append(card);
    });
  }

  async function loadOrders() {
    const status = orderFilter.value;
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const data = await api(`/api/admin/orders${query}`);
    orders = data.orders || [];
    renderOrders();
  }

  async function loadBooks() {
    const data = await api("/api/admin/books");
    books = data.books || [];
    renderBooks();
  }

  function fillContentForm(content: SiteContent = {}) {
    if (!contentForm) return;
    contentForm.querySelectorAll("[data-content-field]").forEach((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      const value = content[el.getAttribute("data-content-field") || ""];
      el.value = typeof value === "string" ? value : "";
    });
  }

  async function loadContent() {
    if (!contentForm) return;
    const data = await api("/api/admin/content");
    fillContentForm(data.content || {});
  }

  function setMessage(el: HTMLElement | null, text: string, ok: boolean) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("admin-message--ok", Boolean(ok) && Boolean(text));
  }

  async function saveOrder(orderId: string) {
    const card = ordersList.querySelector(`[data-order-id="${CSS.escape(orderId)}"]`);
    if (!card) return;
    const payload = {
      fulfillmentStatus: element("[data-order-status]", HTMLSelectElement, card).value,
      trackingNumber: element("[data-order-tracking]", HTMLInputElement, card).value,
      ownerNotes: element("[data-order-notes]", HTMLTextAreaElement, card).value,
    };
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    await loadOrders();
  }

  async function toggleBook(bookId: string, active: boolean) {
    if (active) {
      await api(`/api/admin/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
    } else {
      await api(`/api/admin/books/${encodeURIComponent(bookId)}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
      });
    }
    await loadBooks();
  }

  async function boot() {
    try {
      await api("/api/admin/me");
      setLoggedIn(true);
      await Promise.all([loadOrders(), loadBooks(), loadContent()]);
    } catch {
      setLoggedIn(false);
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginMessage.textContent = "";
    const password = new FormData(loginForm).get("password");
    try {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      loginForm.reset();
      setLoggedIn(true);
      await Promise.all([loadOrders(), loadBooks(), loadContent()]);
    } catch (error) {
      loginMessage.textContent = errorMessage(error);
    }
  });

  element("[data-logout]", HTMLButtonElement).addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST", body: "{}" }).catch(() => {});
    setLoggedIn(false);
  });

  element("[data-refresh-orders]", HTMLButtonElement).addEventListener("click", () => {
    loadOrders().catch((error) => {
      ordersList.textContent = errorMessage(error);
    });
  });
  orderFilter.addEventListener("change", () => {
    loadOrders().catch((error) => {
      ordersList.textContent = errorMessage(error);
    });
  });

  ordersList.addEventListener("click", (event) => {
    const save = event.target instanceof Element ? event.target.closest("[data-save-order]") : null;
    if (!(save instanceof HTMLButtonElement)) return;
    save.disabled = true;
    saveOrder(save.dataset.saveOrder || "")
      .catch((error) => {
        save.disabled = false;
        alert(errorMessage(error));
      });
  });

  booksList.addEventListener("click", (event) => {
    const toggle = event.target instanceof Element ? event.target.closest("[data-toggle-book]") : null;
    if (!(toggle instanceof HTMLButtonElement)) return;
    toggle.disabled = true;
    toggleBook(toggle.dataset.toggleBook || "", toggle.dataset.active === "true")
      .catch((error) => {
        toggle.disabled = false;
        alert(errorMessage(error));
      });
  });

  bookForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(bookMessage, "", false);
    const submit = element("button[type=submit]", HTMLButtonElement, bookForm);
    submit.disabled = true;
    submit.textContent = "Uploading...";
    try {
      const formData = new FormData(bookForm);
      formData.set("active", input(bookForm, "active").checked ? "true" : "false");
      await api("/api/admin/books", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
      });
      bookForm.reset();
      input(bookForm, "price").value = "3.99";
      input(bookForm, "currency").value = "usd";
      input(bookForm, "active").checked = true;
      setMessage(bookMessage, "Book uploaded and catalog refreshed.", true);
      await loadBooks();
    } catch (error) {
      setMessage(bookMessage, errorMessage(error), false);
    } finally {
      submit.disabled = false;
      submit.textContent = "Upload Book";
    }
  });

  if (contentForm) {
    contentForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(contentMessage, "", false);
      const submit = element("button[type=submit]", HTMLButtonElement, contentForm);
      submit.disabled = true;
      submit.textContent = "Saving...";
      try {
        const content: SiteContent = {};
        contentForm.querySelectorAll("[data-content-field]").forEach((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
          content[el.getAttribute("data-content-field") || ""] = el.value;
        });
        const data = await api("/api/admin/content", {
          method: "PATCH",
          body: JSON.stringify({ content }),
        });
        fillContentForm(data.content || {});
        setMessage(contentMessage, "Website text saved. Reload the homepage to see it live.", true);
      } catch (error) {
        setMessage(contentMessage, errorMessage(error), false);
      } finally {
        submit.disabled = false;
        submit.textContent = "Save Website Text";
      }
    });
  }

  if (contentReload) {
    contentReload.addEventListener("click", () => {
      setMessage(contentMessage, "", false);
      loadContent().catch((error) => setMessage(contentMessage, errorMessage(error), false));
    });
  }

  void boot();
})();
