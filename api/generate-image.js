const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3-pro-image";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildPayload({ finalPrompt, inputMimeType, inputBase64 }, mode) {
  const base = {
    contents: [
      {
        parts: [
          { text: finalPrompt },
          {
            inlineData: {
              mimeType: inputMimeType,
              data: inputBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"]
    }
  };

  if (mode === "enum-response-format") {
    base.generationConfig.responseFormat = {
      image: {
        aspectRatio: "ASPECT_RATIO_1_1",
        imageSize: "IMAGE_SIZE_2K"
      }
    };
  }

  if (mode === "image-config") {
    base.generationConfig.imageConfig = {
      aspectRatio: "1:1",
      imageSize: "2K"
    };
  }

  if (mode === "minimal") {
    // Sin aspectRatio/imageSize. Lo dejamos en el prompt para evitar error de enum/config.
  }

  return base;
}

function shouldRetryWithoutImageConfig(status, message) {
  if (status !== 400) return false;

  const lower = String(message || "").toLowerCase();

  return (
    lower.includes("generation_config") ||
    lower.includes("response_format") ||
    lower.includes("image_config") ||
    lower.includes("aspect_ratio") ||
    lower.includes("image_size") ||
    lower.includes("invalid value")
  );
}

async function callGemini({ finalPrompt, inputMimeType, inputBase64 }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const attempts = [
    "enum-response-format",
    "image-config",
    "minimal"
  ];

  let lastError = null;

  for (const mode of attempts) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildPayload({ finalPrompt, inputMimeType, inputBase64 }, mode))
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      return {
        data,
        mode
      };
    }

    const message = data?.error?.message || `Error Gemini ${response.status}`;
    lastError = {
      status: response.status,
      message,
      data,
      mode
    };

    if ([401, 403, 429].includes(response.status)) {
      break;
    }

    if (!shouldRetryWithoutImageConfig(response.status, message)) {
      break;
    }
  }

  const error = new Error(lastError?.message || "Error al generar imagen con Gemini.");
  error.status = lastError?.status || 500;
  error.details = lastError?.data || null;
  error.mode = lastError?.mode || "";
  throw error;
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const {
      user,
      adminPin,
      sku,
      prompt,
      pos1Url,
      optionNumber
    } = req.body || {};

    if (user !== "Pablo") {
      return res.status(403).json({ error: "Solo Pablo puede usar la generación IA." });
    }

    if (!process.env.ADMIN_IA_PIN) {
      return res.status(500).json({ error: "Falta configurar ADMIN_IA_PIN en Vercel." });
    }

    if (adminPin !== process.env.ADMIN_IA_PIN) {
      return res.status(403).json({ error: "Clave IA incorrecta." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel." });
    }

    if (!sku || !prompt || !pos1Url) {
      return res.status(400).json({ error: "Faltan datos obligatorios: sku, prompt o pos1Url." });
    }

    const cleanOption = Number(optionNumber || 1);
    const finalOption = cleanOption === 2 ? 2 : 1;

    const pos1Response = await fetch(pos1Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FlujoIA/1.0"
      }
    });

    if (!pos1Response.ok) {
      return res.status(400).json({
        error: `No se pudo descargar la referencia POS1. Estado: ${pos1Response.status}`
      });
    }

    const inputMimeType = pos1Response.headers.get("content-type") || "image/jpeg";
    const inputBuffer = Buffer.from(await pos1Response.arrayBuffer());
    const inputBase64 = inputBuffer.toString("base64");

    const finalPrompt = `
${prompt}

Instrucciones adicionales para la generación IA:
- Usa la imagen adjunta como referencia real del producto.
- Mantén forma, proporciones, color, logos, textos, estampados, materialidad y detalles reales del producto.
- No cambies el diseño del producto.
- Genera UNA sola imagen final.
- Crear una ambientación comercial realista, limpia, atractiva y apta para ecommerce.
- Fondo y elementos coherentes con el uso del producto, sin saturar la escena.
- El producto debe ser el protagonista.
- Estilo fotográfico profesional.
- No agregar texto extra ni marcas de agua.
- Relación de aspecto 1:1.
- Tamaño/calidad objetivo: 2K.
- Esta es la opción ${finalOption} de 2, por lo tanto debe sentirse distinta a la otra propuesta.
`.trim();

    const { data: geminiData, mode } = await callGemini({
      finalPrompt,
      inputMimeType,
      inputBase64
    });

    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part?.inlineData?.data);

    if (!imagePart) {
      return res.status(500).json({
        error: "Gemini no devolvió ninguna imagen."
      });
    }

    const outputMimeType = imagePart.inlineData.mimeType || "image/png";
    const ext = outputMimeType.includes("jpeg") || outputMimeType.includes("jpg") ? "jpg" : "png";
    const imageBase64 = imagePart.inlineData.data;

    const fileName = `${sku}_${finalOption === 1 ? "005" : "006"}.${ext}`;

    return res.status(200).json({
      ok: true,
      fileName,
      mimeType: outputMimeType,
      base64: imageBase64,
      configMode: mode
    });
  } catch (error) {
    console.error("generate-image error:", error);

    return res.status(error.status || 500).json({
      error: error.message || "Error interno del servidor.",
      mode: error.mode || undefined
    });
  }
}
