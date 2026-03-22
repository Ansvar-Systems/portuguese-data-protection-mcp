/**
 * Seed the CNPD database with sample decisions and guidelines for testing.
 *
 * Includes real CNPD decisions (INE Census 2021, CGD bank, hospital breach)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CNPD_PT_DB_PATH"] ?? "data/cnpd.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "consentimento",
    name_local: "Consentimento",
    name_en: "Consent",
    description: "Recolha, validade e revogação do consentimento para o tratamento de dados pessoais (art. 7.º RGPD).",
  },
  {
    id: "cookies",
    name_local: "Cookies e rastreadores",
    name_en: "Cookies and trackers",
    description: "Colocação e leitura de cookies e rastreadores no dispositivo do utilizador (Lei das Comunicações Eletrónicas).",
  },
  {
    id: "transferencias",
    name_local: "Transferências internacionais",
    name_en: "International transfers",
    description: "Transferência de dados pessoais para países terceiros ou organizações internacionais (art. 44.º–49.º RGPD).",
  },
  {
    id: "avaliacao_impacto",
    name_local: "Avaliação de impacto (AIPD)",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Avaliação dos riscos para os direitos e liberdades dos titulares em tratamentos de elevado risco (art. 35.º RGPD).",
  },
  {
    id: "violacao_dados",
    name_local: "Violação de dados pessoais",
    name_en: "Data breach notification",
    description: "Notificação de violações de dados pessoais à CNPD e aos titulares afetados (art. 33.º–34.º RGPD).",
  },
  {
    id: "privacidade_design",
    name_local: "Privacidade desde a conceção",
    name_en: "Privacy by design",
    description: "Integração da proteção de dados desde a conceção e por defeito (art. 25.º RGPD).",
  },
  {
    id: "empregados",
    name_local: "Dados de trabalhadores",
    name_en: "Employee data",
    description: "Tratamento de dados pessoais em contexto laboral e monitorização de trabalhadores.",
  },
  {
    id: "saude",
    name_local: "Dados de saúde",
    name_en: "Health data",
    description: "Tratamento de dados de saúde — categorias especiais com garantias reforçadas (art. 9.º RGPD).",
  },
  {
    id: "direitos_titulares",
    name_local: "Direitos dos titulares",
    name_en: "Data subject rights",
    description: "Direitos dos titulares de dados: acesso, retificação, apagamento, portabilidade e oposição (art. 12.º–23.º RGPD).",
  },
  {
    id: "videovigilancia",
    name_local: "Videovigilância",
    name_en: "Video surveillance",
    description: "Videovigilância em espaços públicos, locais de trabalho e zonas residenciais.",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // INE Census 2021 — suspended
  {
    reference: "Proc. 4792/2021",
    title: "Deliberação sobre o Recenseamento Geral da População 2021 — INE",
    date: "2021-03-05",
    type: "deliberacao",
    entity_name: "Instituto Nacional de Estatística (INE)",
    fine_amount: null,
    summary:
      "A CNPD suspendeu temporariamente o tratamento de dados pessoais no âmbito dos Censos 2021 por o INE não ter implementado medidas técnicas adequadas para proteger a confidencialidade dos dados dos cidadãos, nomeadamente a ausência de pseudonimização e cifragem dos dados em trânsito.",
    full_text:
      "A Comissão Nacional de Proteção de Dados (CNPD) deliberou, na sua reunião de 5 de março de 2021, suspender temporariamente o tratamento de dados pessoais no âmbito dos Censos 2021 realizado pelo Instituto Nacional de Estatística (INE). A CNPD identificou as seguintes deficiências: (1) Insuficiência de medidas técnicas de segurança — os dados pessoais dos cidadãos eram transmitidos sem cifração adequada; a ausência de pseudonimização dos dados em certas fases do tratamento tornava os dados diretamente identificáveis; (2) Falta de avaliação de impacto completa — o tratamento de dados de toda a população portuguesa constitui um tratamento de elevado risco que requer uma Avaliação de Impacto sobre a Proteção de Dados (AIPD) completa e adequada, que o INE não tinha realizado na totalidade; (3) Insuficiências no Relatório de Proteção de Dados — o relatório apresentado pelo INE não identificou adequadamente todos os riscos e as medidas compensatórias necessárias. A suspensão foi levantada após o INE implementar as medidas corretivas exigidas pela CNPD. Este caso ilustra a obrigação de realizar DPIAs para tratamentos de dados em larga escala que envolvam dados sensíveis da população.",
    topics: JSON.stringify(["avaliacao_impacto", "privacidade_design"]),
    gdpr_articles: JSON.stringify(["32", "35", "36"]),
    status: "final",
  },
  // CGD bank
  {
    reference: "Proc. 3201/2020",
    title: "Deliberação com coima — Caixa Geral de Depósitos, S.A.",
    date: "2021-07-15",
    type: "deliberacao",
    entity_name: "Caixa Geral de Depósitos, S.A.",
    fine_amount: 150_000,
    summary:
      "A CNPD aplicou uma coima de 150 000 euros à Caixa Geral de Depósitos por tratamento excessivo de dados pessoais de clientes para fins de marketing direto sem base legal adequada, e por não respeitar os direitos de oposição dos titulares de dados.",
    full_text:
      "A Comissão Nacional de Proteção de Dados deliberou aplicar uma coima de 150 000 euros à Caixa Geral de Depósitos, S.A. (CGD). A investigação da CNPD revelou que a CGD: (1) Tratava dados pessoais de clientes para fins de marketing direto — envio de comunicações comerciais por e-mail, SMS e telefone — sem uma base legal válida; a CGD invocou o interesse legítimo mas não demonstrou que tal interesse prevalecia sobre os interesses e direitos dos titulares; (2) Não respeitou os direitos de oposição dos titulares — vários clientes tinham exercido o seu direito de oposição ao marketing direto nos termos do artigo 21.º do RGPD, mas continuaram a receber comunicações comerciais; (3) Não dispunha de processos adequados para garantir que os pedidos de oposição eram registados e processados nos sistemas de CRM relevantes. A CNPD determinou que a CGD deve cessar o tratamento de dados para fins de marketing direto em relação a todos os titulares que tenham exercido o seu direito de oposição e implementar procedimentos técnicos e organizacionais adequados.",
    topics: JSON.stringify(["consentimento", "direitos_titulares"]),
    gdpr_articles: JSON.stringify(["6", "17", "21"]),
    status: "final",
  },
  // Hospital data breach
  {
    reference: "Proc. 5678/2022",
    title: "Deliberação com coima — Hospital Centro Hospitalar Universitário",
    date: "2022-11-10",
    type: "deliberacao",
    entity_name: "Centro Hospitalar Universitário de Lisboa Norte, E.P.E.",
    fine_amount: 300_000,
    summary:
      "A CNPD aplicou uma coima de 300 000 euros a um hospital universitário por uma violação de dados que expôs registos de saúde de milhares de doentes e por deficiências nas medidas de segurança das suas bases de dados clínicas.",
    full_text:
      "A Comissão Nacional de Proteção de Dados deliberou aplicar uma coima de 300 000 euros ao Centro Hospitalar Universitário de Lisboa Norte, E.P.E. A violação de dados ocorreu quando uma falha de configuração numa base de dados clínica tornou os registos de saúde de aproximadamente 20 000 doentes acessíveis sem autenticação através da internet durante um período de 48 horas. Os dados expostos incluíam: diagnósticos, historial clínico, medicação, resultados de exames e informações identificativas como nome, data de nascimento e número de utente. A CNPD identificou as seguintes infrações: (1) Medidas de segurança inadequadas — ausência de controlos de acesso adequados e de testes de segurança regulares às bases de dados que processam dados de saúde; os dados de saúde constituem uma categoria especial ao abrigo do artigo 9.º do RGPD e exigem medidas de segurança reforçadas; (2) Violação do prazo de 72 horas — a instituição não notificou a CNPD dentro do prazo de 72 horas previsto no artigo 33.º do RGPD; (3) Comunicação inadequada aos titulares — os doentes afetados não foram devidamente informados da violação nos termos do artigo 34.º do RGPD. A CNPD ordenou ainda a implementação de medidas corretivas urgentes.",
    topics: JSON.stringify(["saude", "violacao_dados", "privacidade_design"]),
    gdpr_articles: JSON.stringify(["9", "32", "33", "34"]),
    status: "final",
  },
  // Videovigilância case
  {
    reference: "Proc. 2890/2021",
    title: "Deliberação — Videovigilância ilegal em local de trabalho",
    date: "2021-10-20",
    type: "deliberacao",
    entity_name: "Empresa de retalho (identidade reservada)",
    fine_amount: 80_000,
    summary:
      "A CNPD aplicou uma coima de 80 000 euros a uma empresa de retalho por utilizar videovigilância nos postos de trabalho dos empregados de forma contínua e desproporcional, sem base legal adequada e sem informar os trabalhadores de forma adequada.",
    full_text:
      "A Comissão Nacional de Proteção de Dados deliberou aplicar uma coima de 80 000 euros a uma empresa do setor do retalho. A empresa instalou câmaras de videovigilância que cobriam permanentemente os postos de trabalho dos empregados, incluindo caixas registadoras e áreas de atendimento ao público. A CNPD constatou que: (1) A videovigilância permanente dos trabalhadores não tem base legal — o Código do Trabalho proíbe a vigilância contínua dos trabalhadores; a lei permite a videovigilância em locais de trabalho apenas por razões de segurança de pessoas e bens, e não para controlo do desempenho dos trabalhadores; (2) Os trabalhadores não foram adequadamente informados — a sinalização existente não indicava quem era o responsável pelo tratamento, a finalidade da videovigilância nem o período de conservação das imagens; (3) As imagens eram conservadas por períodos excessivos — 60 dias, quando o prazo máximo permitido é de 30 dias para videovigilância em locais de trabalho. A CNPD ordenou a remoção das câmaras nos postos de trabalho e a destruição das imagens conservadas em excesso.",
    topics: JSON.stringify(["videovigilancia", "empregados"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "CNPD-ORIENT-COOKIES-2021",
    title: "Orientações sobre cookies e outros meios de rastreamento",
    date: "2021-06-01",
    type: "orientacao",
    summary:
      "Orientações da CNPD sobre o uso de cookies e tecnologias de rastreamento. Esclarece quando é necessário consentimento, como deve ser apresentado o banner de cookies e o que se aplica a serviços de terceiros.",
    full_text:
      "A Comissão Nacional de Proteção de Dados emitiu estas orientações para clarificar as regras aplicáveis ao uso de cookies e tecnologias de rastreamento similares. Aplicação do RGPD e Lei das Comunicações Eletrónicas: o depósito de cookies no dispositivo do utilizador requer consentimento prévio, salvo para cookies estritamente necessários ao funcionamento do serviço. Requisitos do consentimento: (1) O consentimento deve ser livre — o acesso ao serviço não pode ser condicionado à aceitação de todos os cookies; (2) O consentimento deve ser específico — o utilizador deve poder aceitar ou recusar por categoria de cookie (analíticos, marketing, redes sociais); (3) O consentimento deve ser informado — o utilizador deve saber quem recolhe os dados, para que fins e quem são os terceiros envolvidos; (4) O consentimento deve ser dado por ação positiva — caixas pré-selecionadas ou aceitação por omissão não são válidas. Banner de cookies: deve apresentar as opções de aceitar e rejeitar com igual destaque; o botão 'Rejeitar todos' deve ser tão facilmente acessível como 'Aceitar todos'. Serviços de terceiros: a utilização de Google Analytics, Meta Pixel e serviços similares implica transferências de dados que devem ter base legal adequada.",
    topics: JSON.stringify(["cookies", "consentimento"]),
    language: "pt",
  },
  {
    reference: "CNPD-ORIENT-VIDEOVIG-2022",
    title: "Orientações sobre videovigilância",
    date: "2022-04-01",
    type: "orientacao",
    summary:
      "Orientações da CNPD sobre o tratamento de dados pessoais através de sistemas de videovigilância em espaços públicos, locais de trabalho e zonas residenciais.",
    full_text:
      "A videovigilância envolve o tratamento de dados pessoais e está sujeita às regras do RGPD. A CNPD emitiu estas orientações para clarificar as obrigações dos responsáveis pelo tratamento. Bases legais — a videovigilância pode basear-se em: interesse legítimo (art. 6.º/1/f) para fins de segurança de pessoas e bens, desde que não prevaleçam os interesses dos titulares; obrigação legal; consentimento dos titulares (apenas em determinados contextos). Limitações no contexto laboral — o Código do Trabalho proíbe a vigilância contínua e sistemática dos trabalhadores; câmaras que cobrem permanentemente os postos de trabalho são geralmente ilegais; são permitidas câmaras para proteção de bens (caixas, entradas) mas não para controlo do desempenho. Informação aos titulares — sinalética visível é obrigatória; deve indicar: identidade do responsável pelo tratamento, finalidade, período de conservação e contacto do encarregado de proteção de dados. Conservação das imagens — o prazo máximo é de 30 dias, salvo disposição legal em contrário ou necessidade justificada para fins de prova. Avaliação de impacto — a videovigilância em larga escala ou em locais sensíveis requer AIPD.",
    topics: JSON.stringify(["videovigilancia", "empregados", "avaliacao_impacto"]),
    language: "pt",
  },
  {
    reference: "CNPD-ORIENT-TRANSF-2022",
    title: "Diretrizes sobre transferências internacionais de dados pessoais",
    date: "2022-09-01",
    type: "diretriz",
    summary:
      "Diretrizes da CNPD sobre transferências de dados pessoais para países terceiros após o acórdão Schrems II. Aborda os mecanismos de transferência disponíveis e as medidas suplementares necessárias.",
    full_text:
      "O acórdão do Tribunal de Justiça da União Europeia no processo C-311/18 (Schrems II) invalidou o Privacy Shield e impôs novas obrigações para transferências de dados para os EUA e outros países terceiros sem nível de proteção adequado. Mecanismos de transferência disponíveis: (1) Decisão de adequação — a transferência é autorizada para países com nível de proteção adequado reconhecido pela Comissão Europeia; (2) Cláusulas contratuais-tipo (CCT) — as novas CCT adotadas pela Comissão em 2021 devem ser usadas; exigem uma avaliação do nível de proteção no país de destino (TIA — Transfer Impact Assessment); (3) Regras vinculativas para as empresas (BCR) — para transferências intragrupo; (4) Derrogações — apenas aplicáveis em situações específicas e não a transferências sistemáticas. Avaliação de impacto da transferência (TIA): para cada transferência com base em CCT, o exportador deve avaliar se a legislação do país de destino compromete a eficácia das CCT; os EUA requerem atenção especial dada a legislação FISA e as ordens de segurança nacional. Serviços de cloud — a utilização de serviços como AWS, Azure, Google Cloud, Salesforce implica frequentemente transferências para os EUA; o exportador deve verificar as garantias contratuais e técnicas do fornecedor.",
    topics: JSON.stringify(["transferencias"]),
    language: "pt",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
