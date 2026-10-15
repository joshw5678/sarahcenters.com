(() => {
  "use strict";

  const message = document.querySelector("[data-purchase-message]");
  const booksRoot = document.querySelector("[data-purchase-books]");
  const libraryLink = document.querySelector("[data-library-link]");
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const sessionId = params.get("session_id") || sessionStorage.getItem("tc_checkout_session") || "";
  if (params.get("session_id")) {
    sessionStorage.setItem("tc_checkout_session", sessionId);
    history.replaceState(null, "", location.pathname);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "The purchase could not be loaded.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function jsonOptions(body, csrfToken) {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(body),
    };
  }

  function setMessage(text, kind = "info") {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  async function download(book, format, account, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Preparing...";
    try {
      const data = await api(
        `/api/library/${encodeURIComponent(book.id)}/download`,
        jsonOptions({ format }, account.csrfToken)
      );
      window.location.assign(data.url);
    } catch (error) {
      setMessage(error.message, "error");
      button.disabled = false;
      button.textContent = original;
    }
  }

  function renderBooks(books, account) {
    booksRoot.replaceChildren();
    books.forEach((book) => {
      const article = document.createElement("article");
      article.className = "purchase-book";
      const image = document.createElement("img");
      image.src = book.image;
      image.alt = `${book.title} cover`;
      const body = document.createElement("div");
      const title = document.createElement("h2");
      title.textContent = book.title;
      const actions = document.createElement("div");
      actions.className = "receipt-actions";
      book.formats.forEach((format) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = format === "epub" ? "btn btn--solid" : "btn btn--outline-dark";
        button.textContent = `Download ${format.toUpperCase()}`;
        button.addEventListener("click", () => download(book, format, account, button));
        actions.append(button);
      });
      body.append(title, actions);
      article.append(image, body);
      booksRoot.append(article);
    });
  }

  async function load() {
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{10,255}$/.test(sessionId)) {
      setMessage("This Checkout Session is missing or invalid.", "error");
      return;
    }
    let account;
    try {
      account = await api("/api/account/me");
    } catch (error) {
      if (error.status === 401) {
        const destination = `/success.html#session_id=${encodeURIComponent(sessionId)}`;
        window.location.replace(`/login.html?return=${encodeURIComponent(destination)}`);
        return;
      }
      setMessage(error.message, "error");
      return;
    }
    if (!account.user.emailVerified) {
      const destination = `/success.html#session_id=${encodeURIComponent(sessionId)}`;
      window.location.replace(`/verify-email.html?return=${encodeURIComponent(destination)}`);
      return;
    }

    const delays = [0, 900, 1600, 2600, 4200, 6500, 9000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      try {
        const data = await api(
          "/api/checkout/status",
          jsonOptions({ sessionId }, account.csrfToken)
        );
        if (data.status === "ready") {
          setMessage("Payment confirmed. Your purchased editions are ready.", "success");
          renderBooks(data.books || [], account);
          libraryLink.hidden = false;
          localStorage.removeItem("tc_cart");
          sessionStorage.removeItem("tc_checkout_session");
          return;
        }
        setMessage(
          "Stripe confirmed your return. We’re waiting for the signed webhook to finish adding the books to your library.",
          "info"
        );
      } catch (error) {
        if (error.status === 404) {
          setMessage(
            "This Checkout Session is invalid or belongs to another account.",
            "error"
          );
          return;
        }
        setMessage(error.message, "error");
        return;
      }
    }
    setMessage(
      "Your payment is still processing. You can safely open My Library in a moment; access appears only after the verified Stripe webhook completes.",
      "info"
    );
    libraryLink.hidden = false;
  }

  load();
})();
