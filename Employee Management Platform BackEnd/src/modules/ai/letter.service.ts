import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { DocumentRequestType } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Drafts the body of an HR letter (employment certificate, salary certificate,
 * NOC, visa letter) in English and Arabic.
 *
 * Three rules shape this module:
 *
 *  1. **The template is the floor, the model is the ceiling.** Every letter type
 *     has a deterministic template that always produces a valid, signable letter.
 *     The model improves the wording; it is never the only thing standing between
 *     an approval and a usable document. With no API key configured the feature
 *     degrades to templates and the product keeps working - which is why the
 *     demo needs no credentials to be evaluated.
 *
 *  2. **The model never sees data the letter may not contain.** Salary is passed
 *     only when the employee explicitly asked for it to be stated. Nothing is
 *     redacted after generation, because the sensitive value was never in the
 *     prompt to begin with.
 *
 *  3. **Facts come from the database, not the model.** The prompt carries the
 *     employment record as structured values and forbids inventing anything.
 *     Output is constrained by a schema, so a malformed response is a caught
 *     error rather than a corrupt letter.
 */

const LETTER_TITLES: Record<DocumentRequestType, { en: string; ar: string }> = {
  EMPLOYMENT_CERTIFICATE: { en: 'Employment Certificate', ar: 'شهادة عمل' },
  SALARY_CERTIFICATE: { en: 'Salary Certificate', ar: 'شهادة راتب' },
  EXPERIENCE_LETTER: { en: 'Experience Letter', ar: 'شهادة خبرة' },
  NOC_TRAVEL: { en: 'No Objection Certificate', ar: 'شهادة عدم ممانعة' },
  VISA_LETTER: { en: 'Visa Support Letter', ar: 'خطاب دعم تأشيرة' },
  BANK_ACCOUNT_LETTER: { en: 'Bank Account Opening Letter', ar: 'خطاب فتح حساب بنكي' },
};

/** Everything a letter may state. Assembled by the caller from the database. */
export interface LetterFacts {
  documentType: DocumentRequestType;
  reference: string;
  employeeName: string;
  employeeNumber: string;
  jobTitle: string;
  department: string;
  hireDate: string;
  employmentType: string;
  status: string;
  nationality: string | null;
  legalEntityName: string;
  legalEntityCity: string;
  legalEntityCountry: string;
  registrationNumber: string;
  purpose: string;
  addressedTo: string | null;
  /** Present only when the employee asked for the salary to be stated. */
  salary: { amount: number; currency: string; frequency: string } | null;
  issuedOn: string;
}

export interface GeneratedLetter {
  contentEn: string;
  contentAr: string;
  isAiGenerated: boolean;
}

/**
 * The response contract, declared twice on purpose.
 *
 * `LETTER_OUTPUT_SCHEMA` is sent to Gemini as `responseJsonSchema` so the model
 * is constrained to this shape; the Zod schema validates what actually comes
 * back. Constraining the request is not the same as trusting the response - the
 * second check is what turns a malformed reply into a caught error rather than a
 * corrupt letter.
 */
const LETTER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    english: {
      type: 'string',
      description: 'The complete English letter, including date, reference, addressee, subject, body and closing.',
    },
    arabic: {
      type: 'string',
      description: 'The same letter in formal Modern Standard Arabic, with the same structure.',
    },
  },
  required: ['english', 'arabic'],
  additionalProperties: false,
} as const;

const letterSchema = z.object({
  english: z.string().min(1),
  arabic: z.string().min(1),
});

function formatMoney(salary: NonNullable<LetterFacts['salary']>): string {
  return `${salary.currency} ${salary.amount.toLocaleString('en-US')} per ${salary.frequency.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Deterministic templates - the guaranteed floor
// ---------------------------------------------------------------------------

function templateEnglish(facts: LetterFacts): string {
  const salaryLine = facts.salary
    ? ` The current gross compensation is ${formatMoney(facts.salary)}.`
    : '';
  const addressee = facts.addressedTo ? `${facts.addressedTo}` : 'To Whom It May Concern';

  const body = {
    EMPLOYMENT_CERTIFICATE: `This is to certify that ${facts.employeeName} (employee number ${facts.employeeNumber}) has been employed by ${facts.legalEntityName} as ${facts.jobTitle} in the ${facts.department} department since ${facts.hireDate}. The employment is ${facts.employmentType.toLowerCase().replace('_', ' ')} and currently active.${salaryLine}`,
    SALARY_CERTIFICATE: `This is to certify that ${facts.employeeName} (employee number ${facts.employeeNumber}) is employed by ${facts.legalEntityName} as ${facts.jobTitle} since ${facts.hireDate}.${salaryLine}`,
    EXPERIENCE_LETTER: `This is to certify that ${facts.employeeName} (employee number ${facts.employeeNumber}) has served ${facts.legalEntityName} as ${facts.jobTitle} in the ${facts.department} department since ${facts.hireDate}. During this period their conduct and performance have been satisfactory.${salaryLine}`,
    NOC_TRAVEL: `${facts.legalEntityName} has no objection to ${facts.employeeName} (employee number ${facts.employeeNumber}), employed as ${facts.jobTitle} since ${facts.hireDate}, travelling abroad. The employee remains in our employment and is expected to resume duties following the trip.${salaryLine}`,
    VISA_LETTER: `${facts.legalEntityName} confirms that ${facts.employeeName} (employee number ${facts.employeeNumber}) is employed as ${facts.jobTitle} since ${facts.hireDate}. This letter is issued to support the visa application and confirms that the employee will return to their duties.${salaryLine}`,
    BANK_ACCOUNT_LETTER: `${facts.legalEntityName} confirms that ${facts.employeeName} (employee number ${facts.employeeNumber}) is employed as ${facts.jobTitle} since ${facts.hireDate}. This letter is issued to support the opening of a bank account.${salaryLine}`,
  }[facts.documentType];

  return [
    `Date: ${facts.issuedOn}`,
    `Reference: ${facts.reference}`,
    '',
    `${addressee},`,
    '',
    `Subject: ${LETTER_TITLES[facts.documentType].en}`,
    '',
    body,
    '',
    `This letter is issued at the request of the employee for the purpose of ${facts.purpose.toLowerCase()} and carries no financial obligation on ${facts.legalEntityName}.`,
    '',
    'Yours sincerely,',
    'People & Culture',
    `${facts.legalEntityName}`,
    `Commercial registration ${facts.registrationNumber} · ${facts.legalEntityCity}, ${facts.legalEntityCountry}`,
  ].join('\n');
}

function templateArabic(facts: LetterFacts): string {
  const salaryLine = facts.salary ? ` ويبلغ إجمالي راتبه الحالي ${formatMoney(facts.salary)}.` : '';
  const addressee = facts.addressedTo ? `السادة / ${facts.addressedTo}` : 'إلى من يهمه الأمر';

  const body = {
    EMPLOYMENT_CERTIFICATE: `تشهد ${facts.legalEntityName} بأن السيد/ة ${facts.employeeName} (الرقم الوظيفي ${facts.employeeNumber}) يعمل لديها بوظيفة ${facts.jobTitle} بإدارة ${facts.department} اعتباراً من ${facts.hireDate}، وما زال على رأس العمل.${salaryLine}`,
    SALARY_CERTIFICATE: `تشهد ${facts.legalEntityName} بأن السيد/ة ${facts.employeeName} (الرقم الوظيفي ${facts.employeeNumber}) يعمل لديها بوظيفة ${facts.jobTitle} اعتباراً من ${facts.hireDate}.${salaryLine}`,
    EXPERIENCE_LETTER: `تشهد ${facts.legalEntityName} بأن السيد/ة ${facts.employeeName} (الرقم الوظيفي ${facts.employeeNumber}) قد عمل لديها بوظيفة ${facts.jobTitle} بإدارة ${facts.department} اعتباراً من ${facts.hireDate}، وكان سلوكه وأداؤه خلال هذه الفترة مرضياً.${salaryLine}`,
    NOC_TRAVEL: `لا مانع لدى ${facts.legalEntityName} من سفر السيد/ة ${facts.employeeName} (الرقم الوظيفي ${facts.employeeNumber})، والذي يعمل لديها بوظيفة ${facts.jobTitle} اعتباراً من ${facts.hireDate}، على أن يعود لمباشرة عمله بعد انتهاء السفر.${salaryLine}`,
    VISA_LETTER: `تفيد ${facts.legalEntityName} بأن السيد/ة ${facts.employeeName} (الرقم الوظيفي ${facts.employeeNumber}) يعمل لديها بوظيفة ${facts.jobTitle} اعتباراً من ${facts.hireDate}. وقد صدر هذا الخطاب لدعم طلب التأشيرة مع تأكيد عودته لمباشرة عمله.${salaryLine}`,
    BANK_ACCOUNT_LETTER: `تفيد ${facts.legalEntityName} بأن السيد/ة ${facts.employeeName} (الرقم الوظيفي ${facts.employeeNumber}) يعمل لديها بوظيفة ${facts.jobTitle} اعتباراً من ${facts.hireDate}. وقد صدر هذا الخطاب لغرض فتح حساب بنكي.${salaryLine}`,
  }[facts.documentType];

  return [
    `التاريخ: ${facts.issuedOn}`,
    `الرقم المرجعي: ${facts.reference}`,
    '',
    `${addressee}،`,
    '',
    `الموضوع: ${LETTER_TITLES[facts.documentType].ar}`,
    '',
    body,
    '',
    `وقد أُعطيت له هذه الشهادة بناءً على طلبه لغرض ${facts.purpose} دون أدنى مسؤولية على ${facts.legalEntityName}.`,
    '',
    'وتفضلوا بقبول فائق الاحترام،',
    'إدارة الموارد البشرية',
    `${facts.legalEntityName}`,
    `سجل تجاري ${facts.registrationNumber} · ${facts.legalEntityCity}، ${facts.legalEntityCountry}`,
  ].join('\n');
}

export function buildTemplateLetter(facts: LetterFacts): GeneratedLetter {
  return {
    contentEn: templateEnglish(facts),
    contentAr: templateArabic(facts),
    isAiGenerated: false,
  };
}

// ---------------------------------------------------------------------------
// Model-drafted letters
// ---------------------------------------------------------------------------

/** Fast and inexpensive, and letter drafting is a formulaic task. */
const LETTER_MODEL = env.GOOGLE_AI_MODEL;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  if (!env.GOOGLE_API_KEY) return null;
  client ??= new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
  return client;
}

export function isAiLetterGenerationEnabled(): boolean {
  return Boolean(env.GOOGLE_API_KEY);
}

function buildPrompt(facts: LetterFacts): string {
  const lines = [
    `Document type: ${LETTER_TITLES[facts.documentType].en}`,
    `Reference: ${facts.reference}`,
    `Issue date: ${facts.issuedOn}`,
    `Addressed to: ${facts.addressedTo ?? 'To Whom It May Concern'}`,
    `Stated purpose: ${facts.purpose}`,
    '',
    `Employee name: ${facts.employeeName}`,
    `Employee number: ${facts.employeeNumber}`,
    `Job title: ${facts.jobTitle}`,
    `Department: ${facts.department}`,
    `Employment start date: ${facts.hireDate}`,
    `Employment type: ${facts.employmentType}`,
    `Employment status: ${facts.status}`,
    facts.nationality ? `Nationality: ${facts.nationality}` : null,
    '',
    `Employer legal name: ${facts.legalEntityName}`,
    `Commercial registration: ${facts.registrationNumber}`,
    `Employer location: ${facts.legalEntityCity}, ${facts.legalEntityCountry}`,
  ].filter(Boolean);

  // The salary line is present only when the employee asked for it. When it is
  // absent, the model has no salary figure to leak.
  if (facts.salary) {
    lines.push('', `Compensation to state in the letter: ${formatMoney(facts.salary)}`);
  } else {
    lines.push('', 'Compensation: NOT to be mentioned. No salary figure is available to you.');
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You draft official HR letters for a company that employs people through separate legal entities in the UAE, Saudi Arabia and Egypt.

Rules:
- Use ONLY the facts given. Never invent names, dates, amounts, titles or registration numbers, and never add a fact that was not supplied.
- If compensation is marked as not to be mentioned, no salary, allowance or pay figure may appear anywhere in either letter.
- Write in the formal register a bank, embassy or government office expects.
- Produce two versions of the same letter: English, and formal Modern Standard Arabic. The Arabic must convey the same facts, not a literal word-for-word translation.
- Each letter must include the date, the reference number, the addressee line, a subject line, the body, and a closing from "People & Culture" with the employer's legal name and commercial registration.
- Do not add a letterhead, logo, placeholder, or signature image. Do not use square brackets or any "[fill this in]" markers - every letter must be complete and signable as written.
- Keep each letter under 220 words.`;

/**
 * Drafts a letter with Gemini, falling back to the template on any failure.
 *
 * Failure here must never block an approval: HR clicking "approve" is a business
 * decision, and a model outage cannot be allowed to hold it up. Every error path
 * returns the template letter instead of throwing.
 */
export async function generateLetter(facts: LetterFacts): Promise<GeneratedLetter> {
  const genai = getClient();
  if (!genai) {
    return buildTemplateLetter(facts);
  }

  try {
    const response = await genai.models.generateContent({
      model: LETTER_MODEL,
      contents: buildPrompt(facts),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // JSON mode: responseJsonSchema requires responseMimeType to be set.
        responseMimeType: 'application/json',
        responseJsonSchema: LETTER_OUTPUT_SCHEMA,
        maxOutputTokens: 4000,
        // Low temperature: a legal letter should be predictable, not creative.
        temperature: 0.2,
        // 0 disables thinking. Filling a fixed letter structure from supplied
        // facts needs no reasoning budget, and disabling it cuts both latency
        // and cost on a task this formulaic.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const raw = response.text;
    const result = raw ? letterSchema.safeParse(JSON.parse(raw)) : null;

    if (!result?.success) {
      logger.warn({ reference: facts.reference }, 'Letter model returned an unusable body; using the template');
      return buildTemplateLetter(facts);
    }
    const parsed = result.data;

    // Defence in depth: if the letter was not supposed to state pay, verify the
    // model did not introduce a figure anyway. Cheap to check, and the failure
    // mode it guards against is a privacy incident.
    if (!facts.salary && mentionsMoney(parsed.english + parsed.arabic)) {
      logger.warn(
        { reference: facts.reference },
        'Letter model introduced a monetary figure that was not authorised; using the template',
      );
      return buildTemplateLetter(facts);
    }

    return { contentEn: parsed.english.trim(), contentAr: parsed.arabic.trim(), isAiGenerated: true };
  } catch (error) {
    logger.error({ err: error, reference: facts.reference }, 'Letter generation failed; using the template');
    return buildTemplateLetter(facts);
  }
}

/**
 * Currency tokens and amount shapes that must not appear in a no-salary letter.
 *
 * A bare run of digits is deliberately NOT treated as money: every legitimate
 * letter carries a hire date, an issue date and a reference number, and matching
 * those would reject valid letters. Money is recognised by a currency word, or
 * by comma-grouped thousands (20,000) - a shape dates and references never take.
 *
 * Arabic currency words are matched without \b, which is ASCII-oriented and does
 * not behave as expected around Arabic script.
 */
const MONEY_PATTERN = /\b(?:AED|SAR|EGP|USD|EUR|GBP)\b|درهم|ريال|جنيه|دولار|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/i;

export function mentionsMoney(text: string): boolean {
  return MONEY_PATTERN.test(text);
}

export const letterTitles = LETTER_TITLES;
