require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Demo catalogue. Replace these records with products synced from your supplier.
// Never accept prices sent by the browser: look up product IDs and prices on the server.
const products = [
  { id: "headphones-01", name: "Wireless Bluetooth Headphones", price: 4999, currency: "gbp", image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80", category: "Electronics", supplier: "cjdropshipping", supplierProductId: "", supplierVariantId: "" },
  { id: "watch-01", name: "Minimalist Gold-Tone Watch", price: 6400, currency: "gbp", image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80", category: "Fashion", supplier: "cjdropshipping", supplierProductId: "", supplierVariantId: "" },
  { id: "lamp-01", name: "Ambient Table Lamp", price: 3850, currency: "gbp", image: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=800&q=80", category: "Home", supplier: "cjdropshipping", supplierProductId: "", supplierVariantId: "" },
  { id: "backpack-01", name: "Everyday Backpack", price: 4200, currency: "gbp", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80", category: "Lifestyle", supplier: "cjdropshipping", supplierProductId: "", supplierVariantId: "" }
];

app.use(express.static(path.join(__dirname, "public")));

// Stripe webhook: use raw body for signature verification.
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.sendStatus(400);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    // TODO: persist paid order in a database, then submit it to the supplier adapter.
    // Do not fulfil until payment is verified and supplier product/variant mappings exist.
    console.log("Paid checkout received:", session.id);
  }
  res.json({ received: true });
});

app.use(express.json());

app.get("/api/products", (_req, res) => res.json(products));

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Stripe is not configured. Add STRIPE_SECRET_KEY to .env." });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Your basket is empty." });

    const line_items = items.map(item => {
      const product = products.find(p => p.id === item.id);
      const quantity = Math.max(1, Math.min(10, Number(item.quantity) || 1));
      if (!product) throw new Error("Unknown product in basket.");
      return {
        quantity,
        price_data: {
          currency: product.currency,
          unit_amount: product.price,
          product_data: { name: product.name, images: [product.image] }
        }
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      billing_address_collection: "required",
      shipping_address_collection: { allowed_countries: ["GB"] },
      success_url: `${process.env.BASE_URL || "http://localhost:3000"}/?checkout=success`,
      cancel_url: `${process.env.BASE_URL || "http://localhost:3000"}/?checkout=cancelled`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not start checkout." });
  }
});

// CJdropshipping API connection
let cjTokenCache = null;

async function getCJAccessToken() {
  const apiKey = process.env.CJ_API_KEY;

  if (!apiKey) {
    throw new Error("CJ_API_KEY is missing.");
  }

  if (cjTokenCache && cjTokenCache.expiresAt > Date.now() + 60000) {
    return cjTokenCache.accessToken;
  }

  const response = await fetch(
    "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ apiKey })
    }
  );

  const result = await response.json();

  if (!response.ok || result.code !== 200 || !result.data?.accessToken) {
    throw new Error(result.message || "CJ authentication failed.");
  }

  cjTokenCache = {
    accessToken: result.data.accessToken,
    expiresAt: result.data.accessTokenExpiryDate
      ? new Date(result.data.accessTokenExpiryDate).getTime()
      : Date.now() + 180 * 24 * 60 * 60 * 1000
  };

  return cjTokenCache.accessToken;
}

app.get("/api/supplier/status", async (_req, res) => {
  if (!process.env.CJ_API_KEY) {
    return res.status(503).json({
      provider: "cjdropshipping",
      connected: false,
      message: "CJ_API_KEY is missing."
    });
  }

  try {
    await getCJAccessToken();

    return res.json({
      provider: "cjdropshipping",
      connected: true,
      message: "CJ API authentication successful."
    });
  } catch (err) {
    console.error("CJ authentication error:", err.message);

    return res.status(502).json({
      provider: "cjdropshipping",
      connected: false,
      message: err.message
    });
  }
});// Search multiple CJdropshipping product categories
app.get("/api/cj/products", async (req, res) => {
  try {
    const token = await getCJAccessToken();

    const category = String(req.query.category || "All");
    const search = String(req.query.keyword || "").trim().slice(0, 100);

    const keywords = {
      All: ["headphones", "watch", "speaker", "bag", "lamp", "jewelry", "fitness", "sunglasses"],
      Electronics: ["headphones", "smart watch", "speaker", "earbuds", "gaming headset"],
      Fashion: ["watch", "sunglasses", "handbag", "backpack", "jewelry"],
      Home: ["lamp", "vase", "wall clock", "cushion", "desk light"],
      Lifestyle: ["water bottle", "sports bag", "yoga mat", "travel accessories", "fitness"]
    };

    const terms = search
      ? [search]
      : (keywords[category] || keywords.All);

    const results = await Promise.all(
      terms.map(async keyword => {
        const url = new URL(
          "https://developers.cjdropshipping.com/api2.0/v1/product/listV2"
        );

        url.searchParams.set("page", "1");
        url.searchParams.set("size", "100");
        url.searchParams.set("keyWord", keyword);
        url.searchParams.set("countryCode", "GB");

        const response = await fetch(url, {
          headers: { "CJ-Access-Token": token }
        });

        const result = await response.json();

        if (!response.ok || result.code !== 200) {
          console.error("CJ search failed:", keyword, result.message);
          return [];
        }

        return (result.data?.content || [])
          .flatMap(item => item.productList || []);
      })
    );

    const unique = new Map();

    results.flat().forEach(product => {
      if (product.id && !unique.has(product.id)) {
        unique.set(product.id, {
          id: product.id,
          name: product.nameEn,
          image: product.bigImage,
          supplierPriceUSD: product.sellPrice,
          sku: product.sku
        });
      }
    });

    res.json({
      provider: "cjdropshipping",
      count: unique.size,
      products: Array.from(unique.values())
    });

  } catch (err) {
    console.error("CJ product search error:", err.message);
    res.status(502).json({ error: err.message });
  }
});
app.listen(port, () => console.log(`VIP STORE running at http://localhost:${port}`));
