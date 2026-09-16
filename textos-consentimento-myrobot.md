# Textos de consentimento — My Robot Manaus (Capta)

Versões: use o código entre colchetes como `texto_versao` no banco. Quando mudar o texto, suba a versão.
Linguagem simples de propósito (LGPD art. 14 §6). Sempre quem aceita é o **responsável**, nunca a criança.

---

## 1. Formulário do site `[site-v1]`

Checkbox obrigatório, em destaque, antes do botão de enviar:

> ☐ **Sou responsável pela criança** e autorizo a My Robot Manaus a guardar meu nome, meu WhatsApp e o nome e a idade do meu filho(a) para entrar em contato e agendar a aula experimental. Os dados ficam só com a escola e são apagados se não seguirmos com a matrícula. [Como cuidamos dos seus dados](#) · [Prefiro conversar sem cadastro](https://wa.me/5592994163709)

Checkbox opcional (separado, desmarcado):

> ☐ Quero receber novidades e promoções da My Robot no WhatsApp.

Grava no Capta: `contato` + `dados_crianca` (obrigatório) e `marketing` (só se marcar).

---

## 2. Bot do WhatsApp `[bot-v1]`

Antes de perguntar o nome/idade da criança (bloco QUALIFICA WHATSAPP, logo após a saudação):

> Antes de continuar: para agendar a aula experimental eu vou guardar seu nome, seu WhatsApp e o nome e a idade da criança. Só a escola vê isso, e a gente apaga se não fizer sentido seguir.
> Você é responsável pela criança e está de acordo? Responda **SIM** para continuar. 🧡

- Resposta `SIM` → grava `contato` + `dados_crianca`, `declarou_responsavel = true`, com o id da mensagem na `evidencia`.
- Outra resposta → bot encerra e avisa que o atendente pode responder dúvidas sem cadastro.
- Não perguntar sobre promoções no bot; o `marketing` fica pro formulário ou pra matrícula.

---

## 3. App de eventos (captação presencial) `[evento-v1]`

Tela do app, lida em voz alta pelo captador antes de digitar (o aceite é tocado pelo responsável, não pelo captador):

> Vou anotar seu nome, seu WhatsApp e o nome e a idade da criança para te mandar o voucher e marcar a aula experimental. Só a My Robot usa isso. Tudo bem?
>
> [ **Sim, sou responsável e autorizo** ]  [ Prefiro não deixar dados ]

Botão "Sim" grava `contato` + `dados_crianca`, `canal = evento`, `registrado_por` = e-mail do captador.

Script de fala (para o captador, quando a pessoa pergunta "pra que vocês querem isso?"):

> "É só pra te mandar o voucher e marcar o horário. A gente não passa pra ninguém e, se você não quiser seguir, apagamos."

---

## 4. Matrícula `[matricula-v1]`

Cláusula para o contrato (base legal = execução de contrato; aqui o consentimento serve só para imagem e marketing):

> **Dados pessoais.** A My Robot Manaus trata os dados do responsável e do aluno (nome, idade, turma, presença e contato) exclusivamente para prestar o serviço contratado, conforme a LGPD (Lei 13.709/2018) e o ECA Digital (Lei 15.211/2025). Os dados do aluno são tratados no seu melhor interesse, limitados ao necessário para a aula. O responsável pode pedir acesso, correção ou exclusão pelo canal ____________. Fornecedores de tecnologia que apoiam a escola (sistema de gestão, WhatsApp, hospedagem) acessam os dados apenas para operar o serviço.
>
> ☐ Autorizo o uso de imagem do aluno em fotos e vídeos de divulgação da escola. *(opcional)*
> ☐ Autorizo receber comunicações promocionais da escola. *(opcional)*

Grava `matricula` (obrigatório), `imagem` e `marketing` (opcionais), `aluno_id` preenchido.

---

## 5. Tablet de check-in `[tablet-v1]`

O tablet não pede dado novo — a criança só toca no próprio nome. Dois textos curtos:

**Tela inicial (para a criança, letras grandes):**

> Oi! Toque no seu nome para avisar que você chegou. 🤖

**Rodapé pequeno (para o responsável):**

> Este tablet só registra presença e, na saída, uma opinião sobre a aula. Nenhum dado novo é coletado. Dúvidas: fale na recepção.

**Pesquisa de satisfação (aluno regular, mensal):** pergunta com estrelas, sem campo de texto livre pra criança, e a resposta é guardada agregada por turma (sem ligar ao nome). Se quiser resposta individual, gravar `pesquisa` no consentimento da matrícula.

---

## 6. Página pública "Como cuidamos dos seus dados" (art. 14 §2)

Uma página no site da My Robot, em lista simples:

- **O que guardamos:** nome e WhatsApp do responsável; nome e idade da criança; conversas de WhatsApp com a escola; presença nas aulas; opinião sobre a aula.
- **Pra quê:** responder você, marcar a aula experimental, organizar turmas e presença.
- **Quem vê:** só a equipe da My Robot e a RISE, que opera o sistema de atendimento em nome da escola.
- **Ferramentas que usamos:** sistema de gestão (Capta/RISE), WhatsApp, hospedagem em nuvem e assistentes de IA para transcrever áudios e sugerir respostas — alguns fora do Brasil, com contrato que proíbe usar seus dados para outro fim.
- **Por quanto tempo:** se você não se matricular, apagamos em até 12 meses. Alunos: durante a matrícula e pelo prazo legal depois.
- **Seus direitos:** ver, corrigir, apagar ou levar seus dados. Peça pelo WhatsApp da escola ou pelo e-mail ____________. Respondemos em até 15 dias.
- **Publicidade:** nunca usamos dados de crianças para anúncios.

---

## Onde ligar no código

| Ponto | Arquivo | Quando gravar |
|---|---|---|
| Site | `capta.html` (form) e `myrobotmanaus/index.html` → `/api/capta-ingest` | no mesmo insert do lead, após o checkbox |
| Bot | Salesbot QUALIFICA WHATSAPP → webhook `capta-kommo.js` (?acao=espelho) | quando o campo "Consentimento" do Kommo = sim (criar campo lista sim/não) |
| Evento | `evento-captacao.html` → `kommo-evento.js` (gravação dupla) | no clique do botão "Sim" |
| Matrícula | desfecho "Matriculou" em `aula-experimental.html` → `capta-whatsapp.js` ação `desfecho` | ao criar `capta_alunos` |
| Remarketing | `retomar.html` | ler de `capta_v_leads_marketing_ok` para mensagens promocionais; contato de retomada de aula agendada continua sendo `contato` |
