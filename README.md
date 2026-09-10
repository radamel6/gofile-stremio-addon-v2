# GoFile → Stremio addon

Este addon lê uma pasta pública do GoFile e apresenta os vídeos como filmes no Stremio.
Por defeito está configurado para a pasta:

`Hg4qUe`

## 1. Testar localmente

Requer Node.js 18+ (20+ recomendado).

```bash
npm start
```

Depois abre:

`http://127.0.0.1:10000/Hg4qUe/manifest.json`

Para instalar num Stremio local, o addon remoto precisa de HTTPS; `127.0.0.1` é a exceção permitida pelo Stremio.

## 2. Publicar no Render (recomendado)

1. Cria um repositório no GitHub, por exemplo `gofile-stremio-addon`.
2. Faz upload de `server.js` e `package.json`.
3. Em Render: New → Web Service.
4. Liga o teu GitHub e escolhe o repositório.
5. Runtime/Language: Node.
6. Build Command: `npm install`
7. Start Command: `npm start`
8. Escolhe Free.
9. Create Web Service.
10. Quando terminar, copia o URL `https://NOME.onrender.com`.

O manifesto será:

`https://NOME.onrender.com/Hg4qUe/manifest.json`

No Stremio, vai a Addons → Add addon, cola esse URL e instala.

## 3. Usar outra pasta GoFile

Se quiseres outra pasta, basta trocar `Hg4qUe` pelo código da pasta:

`https://NOME.onrender.com/OUTROCODIGO/manifest.json`

Não é necessário alterar o código nem fazer novo deploy.

## Notas

- A pasta GoFile tem de ser pública e conter vídeos.
- O addon não descarrega os vídeos para o servidor; entrega ao Stremio o URL de reprodução fornecido pelo GoFile.
- O Render Free pode adormecer após 15 minutos sem tráfego; o primeiro acesso depois disso pode demorar cerca de um minuto.
- O addon usa um token de convidado temporário do GoFile e não pede o teu login/password do GoFile.
