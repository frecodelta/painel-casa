# Painel da Casa 🎄

Painel para o iPad, com tema de Natal: relógio, contagem para o Natal, meteorologia, agenda (com o Google Calendar), lista de compras, orçamento do mês, luzes da Smart Life (Modo Natal e Cozy) e comando da Vodafone TV.

**Abrir:** https://frecodelta.github.io/painel-casa/

## No iPad

1. Abra o endereço no Safari.
2. Partilhar → **Adicionar ao Ecrã Principal**. Abre em ecrã inteiro, com o ícone da árvore.
3. Definições do iPad → Ecrã e Luminosidade → Bloqueio Automático: **Nunca**. Para o fixar nesta app, use o Acesso Guiado (Acessibilidade).

Compras, orçamento, eventos e definições ficam guardados em cada aparelho. Para passar as definições do computador para o iPad: ⚙ → **Passar para o iPad** → aponte a câmara do iPad ao código.

## Luzes da Smart Life

O painel fala com a Tuya Cloud através de uma ponte pequena (`ponte-luzes.js`), que corre grátis na Cloudflare e guarda a chave secreta da Tuya fora do iPad. Os passos estão no painel, em ⚙ → Luzes → "Como ligar a Smart Life".

Atalho para configurar o iPad de uma vez:
`https://frecodelta.github.io/painel-casa/?ponte=https://luzes-casa.SEU-NOME.workers.dev&chave=SUA-CHAVE`

## Google Calendar

A ponte lê o "endereço secreto no formato iCal" do Google Calendar e o painel mostra os eventos com o mesmo aspeto do resto (a verde). Passos em ⚙ → Google Calendar.

## Vodafone TV

A box é Android TV, mas uma página web não consegue falar diretamente com ela. O comando funciona através do Home Assistant, com a integração Android TV Remote. Os passos estão no painel, em ⚙ → Vodafone TV.

## Ficheiros

| Ficheiro | Para quê |
|---|---|
| `index.html` | O painel (página única, sem dependências) |
| `ponte-luzes.js` | Cloudflare Worker: luzes (Tuya Cloud) e Google Calendar (iCal) |
| `qrcode.min.js` | Gerador de códigos QR (Kazuhiko Arase, licença MIT) |
| `icone.png` | Ícone do ecrã principal |
