export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
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
            responseModalities: ["TEXT", "IMAGE"],
            responseFormat: {
              image: {
                aspectRatio: "1:1",
                imageSize: "2K"
              }
            }
          }
        })
      }
    );

    const geminiData = await geminiResponse.json().catch(() => ({}));

    if (!geminiResponse.ok) {
      return res.status(geminiResponse.status).json({
        error: geminiData?.error?.message || "Error al generar imagen con Gemini."
      });
    }

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
      base64: imageBase64
    });
  } catch (error) {
    console.error("generate-image error:", error);

    return res.status(500).json({
      error: error.message || "Error interno del servidor."
    });
  }
}
