(() => {
  "use strict";

  const details = document.querySelector("[data-receipt-details]");
  const message = document.querySelector("[data-receipt-message]");
  const stripeReceipt = document.querySelector("[data-stripe-receipt]");
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");

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

  function addRow(label, value) {
    const row = document.createElement("div");
    row.className = "receipt-row";
    const term = document.createElement("span");
    term.textContent = label;
    const desc = document.createElement("strong");
    desc.textContent = value || "-";
    row.append(term, desc);
    details.append(row);
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

  function renderItems(order) {
    const list = document.createElement("div");
    list.className = "receipt-items";
    order.items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "receipt-item";
      const title = document.createElement("span");
      title.textContent = `${item.quantity} x ${item.title}`;
      const total = document.createElement("strong");
      total.textContent = formatMoney(item.unitAmountCents * item.quantity, item.currency);
      row.append(title, total);
      list.append(row);
    });
    details.append(list);
  }

  async function loadReceipt() {
    if (!sessionId) {
      message.textContent = "No checkout session was provided.";
      return;
    }

    try {
      const response = await fetch(`/api/checkout/receipt?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load this receipt.");

      const order = data.order;
      details.replaceChildren();
      message.textContent =
        order.status === "paid"
          ? "Your payment was received and your order has been sent to the owner."
          : "Stripe is still confirming this payment. Refresh this page in a moment for the final receipt.";

      if (order.status === "paid") localStorage.removeItem("tc_cart");
      addRow("Order", order.id);
      addRow("Status", order.status);
      addRow("Name", order.customer?.name);
      addRow("Email", order.customer?.email);
      addRow("Shipping", addressText(order.customer?.address));
      renderItems(order);
      addRow("Subtotal", formatMoney(order.subtotalCents, order.currency));
      if (order.shippingCents) addRow("Shipping", formatMoney(order.shippingCents, order.currency));
      addRow("Total", formatMoney(order.totalCents, order.currency));

      if (order.receiptUrl) {
        stripeReceipt.href = order.receiptUrl;
        stripeReceipt.hidden = false;
      }
    } catch (error) {
      message.textContent = error.message || "Unable to load this receipt.";
    }
  }

  loadReceipt();
})();
