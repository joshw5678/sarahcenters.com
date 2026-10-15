import type { z } from "zod";
import { AppError, errorMessage, accountResponseSchema, checkoutStatusSchema, downloadResponseSchema } from "../shared/contracts.js";
import type { AccountResponse, PurchaseBook } from "../shared/contracts.js";
import { element, requestJson } from "./browser.js";
(() => {
  "use strict";

  const message = element("[data-purchase-message]", HTMLElement);
  const booksRoot = element("[data-purchase-books]", HTMLElement);
  const libraryLink = element("[data-library-link]", HTMLAnchorElement);
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const sessionId = params.get("session_id") || sessionStorage.getItem("tc_checkout_session") || "";
  if (params.get("session_id")) {
    sessionStorage.setItem("tc_checkout_session", sessionId);
    history.replaceState(null, "", location.pathname);
  }

  function api(path: "/api/account/me", options?: RequestInit): Promise<AccountResponse>;
  function api(path: "/api/checkout/status", options?: RequestInit): Promise<z.infer<typeof checkoutStatusSchema>>;
  function api(path: string, options?: RequestInit): Promise<z.infer<typeof downloadResponseSchema>>;
  async function api(path: string, options: RequestInit = {}) {
    if (path === "/api/account/me") return requestJson(path, accountResponseSchema, options);
    if (path === "/api/checkout/status") return requestJson(path, checkoutStatusSchema, options);
    return requestJson(path, downloadResponseSchema, options);
  }
  function jsonOptions(body: unknown, csrfToken: string) {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(body),
    };
  }

  function setMessage(text: string, kind = "info") {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  async function download(book: PurchaseBook, format: string, account: AccountResponse, button: HTMLButtonElement) {
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
      setMessage(errorMessage(error), "error");
      button.disabled = false;
      button.textContent = original;
    }
  }

  function renderBooks(books: PurchaseBook[], account: AccountResponse) {
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
    let account: AccountResponse;
    try {
      account = await api("/api/account/me");
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        const destination = `/success.html#session_id=${encodeURIComponent(sessionId)}`;
        window.location.replace(`/login.html?return=${encodeURIComponent(destination)}`);
        return;
      }
      setMessage(errorMessage(error), "error");
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
        if (error instanceof AppError && error.status === 404) {
          setMessage(
            "This Checkout Session is invalid or belongs to another account.",
            "error"
          );
          return;
        }
        setMessage(errorMessage(error), "error");
        return;
      }
    }
    setMessage(
      "Your payment is still processing. You can safely open My Library in a moment; access appears only after the verified Stripe webhook completes.",
      "info"
    );
    libraryLink.hidden = false;
  }

  void load().catch((error: unknown) => setMessage(errorMessage(error), "error"));
})();
