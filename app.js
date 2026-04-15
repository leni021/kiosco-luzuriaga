require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const multer = require('multer');

const app = express();

app.use(helmet({
    contentSecurityPolicy: false,
}));

app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'comprobante-' + uniqueSuffix + ext);
    }
});

const fileFilter = function (req, file, cb) {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos JPG y PNG'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});

async function setupDB() {
    const dbPath = process.env.DATABASE_PATH || './kiosco.sqlite';

    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS productos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            categoria TEXT NOT NULL,
            nombre TEXT NOT NULL,
            variante TEXT,
            precio INTEGER NOT NULL,
            es_promo INTEGER DEFAULT 0,
            destacado INTEGER DEFAULT 0
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS pedidos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket TEXT NOT NULL,
            total INTEGER NOT NULL,
            estado TEXT DEFAULT 'Pendiente',
            comprobante TEXT,
            fecha TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    const { count } = await db.get('SELECT COUNT(*) as count FROM productos');
    if (count === 0) {
        await db.exec(`
            INSERT INTO productos (categoria, nombre, variante, precio, es_promo, destacado) VALUES
            ('Comidas', 'Empanadas', 'Carne y Pollo', 1500, 0, 0),
            ('Comidas', 'Sandwich de Milanesa (Carne)', 'Sola', 7000, 0, 1),
            ('Comidas', 'Sandwich de Milanesa (Carne)', 'Promo con Bebida', 7500, 1, 1),
            ('Comidas', 'Pancho', 'Solo', 1500, 0, 0),
            ('Comidas', 'Pancho', 'Promo con Bebida', 2300, 1, 0)
        `);
    }

    return db;
}

const dbPromise = setupDB();

app.get('/', async (req, res) => {
    try {
        const db = await dbPromise;
        const productos = await db.all('SELECT * FROM productos ORDER BY categoria, id');
        const promos = productos.filter(function (p) { return p.es_promo === 1; });
        const individuales = productos.filter(function (p) { return p.es_promo === 0; });
        res.render('index', { promos, individuales, apiKey: process.env.INTERNAL_API_KEY || '' });
    } catch (error) {
        console.error("Error en la base de datos:", error);
        res.status(500).send("Error interno del servidor");
    }
});

app.get('/api/productos', async (req, res) => {
    try {
        const db = await dbPromise;
        const productos = await db.all('SELECT * FROM productos ORDER BY categoria, id');
        res.json(productos);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener productos' });
    }
});

function verifyApiKey(req, res, next) {
    const apiKey = process.env.INTERNAL_API_KEY;
    if (!apiKey) {
        return next();
    }
    const provided = req.headers['x-api-key'];
    if (!provided || provided !== apiKey) {
        return res.status(401).json({ error: 'Acceso no autorizado' });
    }
    next();
}

app.post('/pedido', verifyApiKey, upload.single('comprobante'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'El comprobante de transferencia es obligatorio' });
        }

        const { ticket, total } = req.body;

        if (!ticket || !total) {
            return res.status(400).json({ error: 'Datos del pedido incompletos' });
        }

        const db = await dbPromise;
        const comprobantePath = '/uploads/' + req.file.filename;

        const result = await db.run(
            'INSERT INTO pedidos (ticket, total, comprobante) VALUES (?, ?, ?)',
            [ticket, parseInt(total), comprobantePath]
        );

        const pedidoId = result.lastID;

        const items = JSON.parse(ticket);
        const detallePedido = items.map(function (item) {
            let desc = item.qty + 'x ' + item.nombre + ' (' + item.variante + ')';
            if (item.sabor) {
                desc += ' - Placer ' + item.sabor;
            }
            if (item.conPapas) {
                desc += ' - Con lluvia de papas';
            }
            return desc;
        });

        const wabaToken = process.env.WABA_ACCESS_TOKEN;
        const wabaPhoneId = process.env.WABA_PHONE_NUMBER_ID;
        const destinationPhone = process.env.DESTINATION_PHONE_NUMBER;

        if (wabaToken && wabaPhoneId && destinationPhone) {
            try {
                const filePath = path.join(uploadsDir, req.file.filename);
                const fileBuffer = fs.readFileSync(filePath);
                const blob = new Blob([fileBuffer], { type: req.file.mimetype });

                const mediaForm = new FormData();
                mediaForm.append('messaging_product', 'whatsapp');
                mediaForm.append('type', req.file.mimetype);
                mediaForm.append('file', blob, req.file.filename);

                const mediaRes = await fetch(
                    'https://graph.facebook.com/v20.0/' + wabaPhoneId + '/media',
                    {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + wabaToken },
                        body: mediaForm
                    }
                );

                const mediaData = await mediaRes.json();

                if (!mediaData.id) {
                    console.error('WhatsApp Media Upload fallo:', JSON.stringify(mediaData));
                    return res.json({
                        ok: true,
                        pedido_id: pedidoId,
                        mensaje: 'Pedido registrado, pero el comprobante no pudo enviarse por WhatsApp. Contacta al local.',
                        wa_error: true
                    });
                }

                console.log('WhatsApp Media ID obtenido: ' + mediaData.id);

                const listaProductos = detallePedido.map(function (p) { return '\u2022 ' + p; }).join('\n');
                const caption = '\ud83d\udce6 *NUEVO PEDIDO RECIBIDO*\n'
                    + '--------------------------\n'
                    + '\ud83d\udc64 Cliente: Web Take Away\n'
                    + '\ud83d\udccd Tipo: Retiro en local\n'
                    + '--------------------------\n'
                    + '\ud83d\uded2 *DETALLE DEL PEDIDO:*\n'
                    + listaProductos + '\n'
                    + '--------------------------\n'
                    + '\ud83d\udcb0 *TOTAL A COBRAR:* $' + parseInt(total).toLocaleString('es-AR') + '\n'
                    + '--------------------------\n'
                    + '\ud83d\uddbc\ufe0f El comprobante de pago se adjunta a continuacion.';

                const msgRes = await fetch(
                    'https://graph.facebook.com/v20.0/' + wabaPhoneId + '/messages',
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': 'Bearer ' + wabaToken,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            messaging_product: 'whatsapp',
                            recipient_type: 'individual',
                            to: destinationPhone,
                            type: 'image',
                            image: {
                                id: mediaData.id,
                                caption: caption
                            }
                        })
                    }
                );

                const msgData = await msgRes.json();

                if (msgData.messages && msgData.messages.length > 0) {
                    console.log('WhatsApp mensaje enviado. ID: ' + msgData.messages[0].id);
                } else {
                    console.error('WhatsApp Messages fallo:', JSON.stringify(msgData));
                }

            } catch (waError) {
                console.error('Error en integracion WhatsApp Cloud API:', waError.message);
            }
        } else {
            console.log('WhatsApp Cloud API no configurada. Pedido #' + pedidoId + ' registrado solo en DB.');
        }

        res.json({
            ok: true,
            pedido_id: pedidoId,
            mensaje: 'Pedido registrado correctamente. Estado: Pendiente de validacion.'
        });

    } catch (error) {
        console.error('Error al procesar pedido:', error);
        res.status(500).json({ error: 'Error interno al procesar el pedido' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Servidor corriendo en el puerto ' + PORT);
});