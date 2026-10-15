(() => {
  "use strict";

  const loginPanel = document.querySelector("[data-login-panel]");
  const loginForm = document.querySelector("[data-login-form]");
  const loginMessage = document.querySelector("[data-login-message]");
  const app = document.querySelector("[data-admin-app]");
  const ordersList = document.querySelector("[data-orders-list]");
  const booksList = document.querySelector("[data-books-list]");
  const orderFilter = document.querySelector("[data-order-filter]");
  const bookForm = document.querySelector("[data-book-form]");
  const bookMessage = document.querySelector("[data-book-message]");
  const contentForm = document.querySelector("[data-content-form]");
  const contentMessage = document.querySelector("[data-content-message]");
  const contentReload = document.querySelector("[data-content-reload]");

  let orders = [];
  let books = [];

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: options.body instanceof FormData ? options.headers : {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function formatMoney(cents, currency = "usd") {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: String(currency || "usd").toUpperCase(),
      }).format((Number(cents) || 0) / 100);
    } catch {
      return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
    }
  }

  function formatDate(value) {
    if (!value) return "-";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function addressText(address) {
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

  function itemLabel(item) {
    const format =
      item.formatLabel ||
      (Array.isArray(item.formats) && item.formats.includes("pdf")
        ? "EPUB + PDF"
        : "EPUB");
    return `${item.title} (${format})`;
  }

  function setLoggedIn(isLoggedIn) {
    loginPanel.hidden = isLoggedIn;
    app.hidden = !isLoggedIn;
  }

  function badge(text) {
    const span = document.createElement("span");
    span.className = `admin-badge admin-badge--${String(text || "unknown").toLowerCase()}`;
    span.textContent = text || "unknown";
    return span;
  }

  function field(labelText, value) {
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
      const statusSelect = controls.querySelector("[data-order-status]");
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
      controls.querySelector("[data-order-tracking]").value = order.trackingNumber || "";
      controls.querySelector("[data-order-notes]").value = order.ownerNotes || "";

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
      button.dataset.active = String(book.active);
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

  function fillContentForm(content) {
    if (!contentForm) return;
    contentForm.querySelectorAll("[data-content-field]").forEach((el) => {
      const value = content[el.getAttribute("data-content-field")];
      el.value = typeof value === "string" ? value : "";
    });
  }

  async function loadContent() {
    if (!contentForm) return;
    const data = await api("/api/admin/content");
    fillContentForm(data.content || {});
  }

  function setMessage(el, text, ok) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("admin-message--ok", Boolean(ok) && Boolean(text));
  }

  async function saveOrder(orderId) {
    const card = ordersList.querySelector(`[data-order-id="${CSS.escape(orderId)}"]`);
    if (!card) return;
    const payload = {
      fulfillmentStatus: card.querySelector("[data-order-status]").value,
      trackingNumber: card.querySelector("[data-order-tracking]").value,
      ownerNotes: card.querySelector("[data-order-notes]").value,
    };
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    await loadOrders();
  }

  async function toggleBook(bookId, active) {
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
      loginMessage.textContent = error.message;
    }
  });

  document.querySelector("[data-logout]").addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST", body: "{}" }).catch(() => {});
    setLoggedIn(false);
  });

  document.querySelector("[data-refresh-orders]").addEventListener("click", () => {
    loadOrders().catch((error) => {
      ordersList.textContent = error.message;
    });
  });
  orderFilter.addEventListener("change", () => {
    loadOrders().catch((error) => {
      ordersList.textContent = error.message;
    });
  });

  ordersList.addEventListener("click", (event) => {
    const save = event.target.closest("[data-save-order]");
    if (!save) return;
    save.disabled = true;
    saveOrder(save.dataset.saveOrder)
      .catch((error) => {
        save.disabled = false;
        alert(error.message);
      });
  });

  booksList.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle-book]");
    if (!toggle) return;
    toggle.disabled = true;
    toggleBook(toggle.dataset.toggleBook, toggle.dataset.active === "true")
      .catch((error) => {
        toggle.disabled = false;
        alert(error.message);
      });
  });

  bookForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(bookMessage, "", false);
    const submit = bookForm.querySelector("button[type=submit]");
    submit.disabled = true;
    submit.textContent = "Uploading...";
    try {
      const formData = new FormData(bookForm);
      formData.set("active", bookForm.elements.active.checked ? "true" : "false");
      await api("/api/admin/books", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
      });
      bookForm.reset();
      bookForm.elements.price.value = "3.99";
      bookForm.elements.currency.value = "usd";
      bookForm.elements.active.checked = true;
      setMessage(bookMessage, "Book uploaded and catalog refreshed.", true);
      await loadBooks();
    } catch (error) {
      setMessage(bookMessage, error.message, false);
    } finally {
      submit.disabled = false;
      submit.textContent = "Upload Book";
    }
  });

  if (contentForm) {
    contentForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(contentMessage, "", false);
      const submit = contentForm.querySelector("button[type=submit]");
      submit.disabled = true;
      submit.textContent = "Saving...";
      try {
        const content = {};
        contentForm.querySelectorAll("[data-content-field]").forEach((el) => {
          content[el.getAttribute("data-content-field")] = el.value;
        });
        const data = await api("/api/admin/content", {
          method: "PATCH",
          body: JSON.stringify({ content }),
        });
        fillContentForm(data.content || {});
        setMessage(contentMessage, "Website text saved. Reload the homepage to see it live.", true);
      } catch (error) {
        setMessage(contentMessage, error.message, false);
      } finally {
        submit.disabled = false;
        submit.textContent = "Save Website Text";
      }
    });
  }

  if (contentReload) {
    contentReload.addEventListener("click", () => {
      setMessage(contentMessage, "", false);
      loadContent().catch((error) => setMessage(contentMessage, error.message, false));
    });
  }

  boot();
})();
