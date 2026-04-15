# Kiosco Luzuriaga 92 - Sistema de Automatizacion de Pedidos

## Descripcion
Plataforma fullstack para gestion de pedidos take away con envio automatizado de comprobantes y detalle de compra mediante Meta Cloud API (WhatsApp).

## Tech Stack
- Node.js
- Express
- SQLite
- EJS modular con partials

## Seguridad
Este proyecto utiliza variables de entorno para separar configuracion sensible del codigo fuente.

Puntos clave de seguridad:
- Credenciales y tokens se almacenan en `.env` y nunca deben subirse al repositorio.
- El repositorio incluye un `.gitignore` para bloquear archivos sensibles como `.env`, base de datos local y uploads.
- Se incluye `.env.example` para documentar las variables requeridas sin exponer secretos reales.

## Instalacion
1. Instalar dependencias:
   - `npm install`
2. Configurar variables de entorno:
   - Crear `.env` en la raiz usando `.env.example` como base.
3. Ejecutar en modo desarrollo:
   - `npm run dev`
