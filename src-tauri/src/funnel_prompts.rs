/// Funnel Prompts Module: AIDA & SPIN Frameworks with Meta-Prompting and Humanizer
use crate::commands::HUMANIZER_PROMPT;

/// Role definition for the networking and social selling expert
pub const ROLE_NETWORKING_EXPERT: &str = "\
[РОЛЬ: Эксперт по нетворкингу]\n\
Ты признанный эксперт по деловому нетворкингу, Social Selling и установлению доверительного первого контакта в социальных сетях и мессенджерах. \
Твои сообщения звучат естественно, живо и ненавязчиво, не вызывают отторжения, не содержат спама и стимулируют собеседника с интересом включиться в диалог.";

/// Anti-hallucination and format constraint rules
pub const ANTI_HALLUCINATION_RULES: &str = "\
[ЗАПРЕТ НА МУСОРНЫЕ ФРАЗЫ И ПРИВЕТСТВИЯ АССИСТЕНТА]\n\
КАТЕГОРИЧЕСКИЕ ТРЕБОВАНИЯ К ФОРМАТУ И ОГРАНИЧЕНИЯ:\n\
1. Возвращай ТОЛЬКО итоговый текст сообщения, который будет непосредственно отправлен лиду.\n\
2. ЗАПРЕЩЕНО использовать любые кавычки вокруг текста (двойные \"\", одинарные '', кавычки-ёлочки «»).\n\
3. ЗАПРЕЩЕНЫ любые вступительные фразы или комментарии ассистента (например: 'Вот ваш вариант:', 'Вот сообщение:', 'Конечно, держите:').\n\
4. ЗАПРЕЩЕНЫ плейсхолдеры вроде [Имя], [Компания], [Ссылка], [Ваш продукт]. Все реальные данные уже подставлены в инструкцию.\n\
5. ЗАПРЕЩЕНЫ markdown-блоки кода (не оборачивай текст в ```).\n\
6. Сообщение должно быть готово к отправке лиду 'как есть'.";

/// Checks if the lead has no real name provided
pub fn is_nameless(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    lower.is_empty()
        || lower == "no name"
        || lower == "noname"
        || lower == "unknown"
        || lower == "без имени"
        || lower == "нет имени"
}

/// Resolves the specific stage instruction for AIDA or SPIN frameworks
pub fn get_framework_stage_instruction(
    framework: &str,
    stage: &str,
    lead_name: &str,
    platform: &str,
    custom_context: &str,
) -> (String, String) {
    let fw = framework.trim().to_lowercase();
    let st = stage.trim().to_lowercase();
    let nameless = is_nameless(lead_name);

    let name_target = if nameless {
        "собеседника (имя неизвестно — не используй имя)"
    } else {
        lead_name.trim()
    };

    let context_text = if custom_context.trim().is_empty() {
        "актуальные темы в вашей индустрии"
    } else {
        custom_context.trim()
    };

    match fw.as_str() {
        "aida" => {
            let fw_title = "AIDA (Attention, Interest, Desire, Action)".to_string();
            let instruction = match st.as_str() {
                "attention" | "aida_attention" => {
                    format!(
                        "Создай короткое сообщение (до 3 предложений), чтобы привлечь внимание лида {} на платформе {}. Задай легкий, неформальный вопрос по теме: {}.",
                        name_target, platform, context_text
                    )
                }
                "interest" | "aida_interest" => {
                    format!(
                        "Вызови интерес у лида {} на платформе {}. Поделись интригующим инсайтом или фактом по теме: {}. Покажи экспертизу, но не продавай в лоб.",
                        name_target, platform, context_text
                    )
                }
                "desire" | "aida_desire" => {
                    format!(
                        "Пробуди желание у лида {} на платформе {}. Опиши ценность и конкретный результат решения проблемы в контексте: {}. Покажи выгоду 'до/после'.",
                        name_target, platform, context_text
                    )
                }
                "action" | "aida_action" | "close" | "closed" => {
                    format!(
                        "Призови лида {} к простому целевому действию (Call to Action) без давления на платформе {} по теме: {}. Предложи созвониться на 10 минут или протестировать решение.",
                        name_target, platform, context_text
                    )
                }
                _ => {
                    format!(
                        "Создай сообщение по методологии AIDA (этап '{}') для лида {} на платформе {}. Контекст: {}.",
                        stage, name_target, platform, context_text
                    )
                }
            };
            (fw_title, instruction)
        }
        "spin" => {
            let fw_title = "SPIN (Situation, Problem, Implication, Need-Payoff)".to_string();
            let instruction = match st.as_str() {
                "situation" | "spin_situation" => {
                    format!(
                        "Задай ситуационный вопрос лиду {} на платформе {}, чтобы ненавязчиво прояснить текущие процессы и методы работы по теме: {}.",
                        name_target, platform, context_text
                    )
                }
                "problem" | "spin_problem" => {
                    format!(
                        "Задай проблемный вопрос лиду {}, опираясь на контекст: {}. Цель: заставить человека задуматься о неэффективности его текущих методов. Без приветствия, продолжай диалог.",
                        name_target, context_text
                    )
                }
                "implication" | "spin_implication" => {
                    format!(
                        "Задай извлекающий вопрос лиду {} по теме: {}. Покажи скрытые риски, потери времени или денег, если проблема не будет решена прямо сейчас.",
                        name_target, context_text
                    )
                }
                "need_payoff" | "spin_need_payoff" | "needpayoff" => {
                    format!(
                        "Задай направляющий вопрос лиду {} по теме: {}. Подведи человека к тому, чтобы он сам сформулировал ценность и выгоду от решения проблемы.",
                        name_target, context_text
                    )
                }
                _ => {
                    format!(
                        "Создай вопрос по методологии SPIN (этап '{}') для лида {} на платформе {}. Контекст: {}.",
                        stage, name_target, platform, context_text
                    )
                }
            };
            (fw_title, instruction)
        }
        other => {
            let fw_title = format!("Воронка продаж ({})", other);
            let instruction = format!(
                "Создай персонализированное сообщение этапа '{}' для лида {} на платформе {}. Контекст: {}.",
                stage, name_target, platform, context_text
            );
            (fw_title, instruction)
        }
    }
}

/// Helper to assemble the structured system prompt according to the strict SDD formula:
/// [РОЛЬ: Эксперт по нетворкингу] -> [ПРАВИЛА ВОРОНКИ (AIDA/SPIN)] -> [ПРАВИЛА HUMANIZER (если включен)] -> [ЗАПРЕТ НА МУСОРНЫЕ ФРАЗЫ И ПРИВЕТСТВИЯ АССИСТЕНТА] -> [КОНТЕКСТ ЛИДА]
pub fn build_funnel_system_prompt(
    framework: &str,
    stage: &str,
    lead_name: &str,
    platform: &str,
    custom_context: &str,
    apply_humanizer: bool,
) -> String {
    let mut sections = Vec::with_capacity(5);

    // 1. [РОЛЬ: Эксперт по нетворкингу]
    sections.push(ROLE_NETWORKING_EXPERT.to_string());

    // 2. [ПРАВИЛА ВОРОНКИ (AIDA/SPIN)]
    let (fw_title, stage_instruction) =
        get_framework_stage_instruction(framework, stage, lead_name, platform, custom_context);
    let funnel_rules = format!(
        "[ПРАВИЛА ВОРОНКИ ({})]\n\
         Методология: {}\n\
         Этап: {}\n\
         Инструкция: {}",
        framework.to_uppercase(),
        fw_title,
        stage,
        stage_instruction
    );
    sections.push(funnel_rules);

    // 3. [ПРАВИЛА HUMANIZER (если включен)]
    if apply_humanizer {
        sections.push(HUMANIZER_PROMPT.to_string());
    }

    // 4. [ЗАПРЕТ НА МУСОРНЫЕ ФРАЗЫ И ПРИВЕТСТВИЯ АССИСТЕНТА]
    sections.push(ANTI_HALLUCINATION_RULES.to_string());

    // 5. [КОНТЕКСТ ЛИДА]
    let nameless = is_nameless(lead_name);
    let lead_name_info = if nameless {
        "ВНИМАНИЕ: Имя лида неизвестно. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать 'Привет, No Name', 'Здравствуйте, None' или придумывать имя. Начни сообщение без упоминания имени (например: 'Здравствуйте!', 'Добрый день!', либо начни сразу с сути/вопроса).".to_string()
    } else {
        format!("Имя лида: {} (обращайся к собеседнику по этому имени).", lead_name.trim())
    };

    let context_lead = format!(
        "[КОНТЕКСТ ЛИДА]\n\
         - Платформа: {}\n\
         - {}\n\
         - Дополнительный контекст / предложение: {}",
        platform.trim(),
        lead_name_info,
        if custom_context.trim().is_empty() {
            "Общий нетворкинг и профессиональное знакомство"
        } else {
            custom_context.trim()
        }
    );
    sections.push(context_lead);

    sections.join("\n\n")
}

/// Cleans and sanitizes the LLM response:
/// - Strips markdown code fences
/// - Strips introductory assistant prefixes ("Вот ваш вариант:", etc.)
/// - Strips wrapping quotes
/// - Handles accidental placeholders ([Имя], {lead_name})
pub fn clean_generated_funnel_message(raw: &str, lead_name: &str) -> String {
    let mut text = raw.trim().to_string();

    // 1. Strip markdown code fences if wrapped in ``` ... ```
    if text.starts_with("```") {
        if let Some(first_newline) = text.find('\n') {
            text = text[first_newline + 1..].to_string();
        }
        if text.ends_with("```") {
            text = text[..text.len() - 3].to_string();
        }
        text = text.trim().to_string();
    }

    // 2. Strip common introductory assistant prefixes
    let prefixes = [
        "вот ваш вариант сообщения:",
        "вот ваш вариант:",
        "вот вариант сообщения:",
        "вот пример сообщения:",
        "вот текст сообщения:",
        "вариант сообщения:",
        "текст сообщения:",
        "вот сообщение:",
        "конечно, вот вариант:",
        "конечно! вот вариант:",
        "конечно, вот сообщение:",
    ];

    let lower = text.to_lowercase();
    for prefix in &prefixes {
        if lower.starts_with(prefix) {
            text = text[prefix.len()..].trim().to_string();
            break;
        }
    }

    // 3. Strip surrounding quotation marks ("...", '...', «...», „...“)
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
        || (text.starts_with('«') && text.ends_with('»'))
        || (text.starts_with('„') && text.ends_with('“'))
    {
        if text.len() >= 2 {
            text = text[1..text.len() - 1].trim().to_string();
        }
    }

    // 4. Substitute any leftover placeholders if LLM hallucinated [Имя] or {lead_name}
    let nameless = is_nameless(lead_name);
    if !nameless {
        let name = lead_name.trim();
        text = text
            .replace("[Имя]", name)
            .replace("[имя]", name)
            .replace("[Имя лида]", name)
            .replace("[Name]", name)
            .replace("[name]", name)
            .replace("{lead_name}", name)
            .replace("{name}", name);
    } else {
        text = text
            .replace("[Имя]", "")
            .replace("[имя]", "")
            .replace("[Имя лида]", "")
            .replace("[Name]", "")
            .replace("[name]", "")
            .replace("{lead_name}", "")
            .replace("{name}", "");
        text = text
            .replace("Привет, !", "Привет!")
            .replace("Привет,!", "Привет!")
            .replace("Здравствуйте, !", "Здравствуйте!")
            .replace("Здравствуйте,!", "Здравствуйте!")
            .replace(", !", "!")
            .replace(",!", "!")
            .replace("  ", " ")
            .replace(" ,", ",");
    }

    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_funnel_prompt_aida_attention_structure() {
        let prompt = build_funnel_system_prompt(
            "aida",
            "attention",
            "Алексей",
            "vk",
            "автоматизация постинга",
            true,
        );

        // Invariant: Formula structure check:
        // [РОЛЬ: Эксперт по нетворкингу] -> [ПРАВИЛА ВОРОНКИ] -> [HUMANIZER] -> [ЗАПРЕТ НА МУСОРНЫЕ ФРАЗЫ] -> [КОНТЕКСТ ЛИДА]
        let role_idx = prompt.find("[РОЛЬ: Эксперт по нетворкингу]").expect("Must contain role");
        let funnel_idx = prompt.find("[ПРАВИЛА ВОРОНКИ (AIDA)]").expect("Must contain funnel rules");
        let humanizer_idx = prompt.find("HUMANIZATION RULES:").expect("Must contain humanizer rules when true");
        let bans_idx = prompt.find("[ЗАПРЕТ НА МУСОРНЫЕ ФРАЗЫ И ПРИВЕТСТВИЯ АССИСТЕНТА]").expect("Must contain bans");
        let context_idx = prompt.find("[КОНТЕКСТ ЛИДА]").expect("Must contain lead context");

        assert!(role_idx < funnel_idx);
        assert!(funnel_idx < humanizer_idx);
        assert!(humanizer_idx < bans_idx);
        assert!(bans_idx < context_idx);

        // Check AIDA Attention contract text
        assert!(prompt.contains("Создай короткое сообщение (до 3 предложений), чтобы привлечь внимание лида Алексей на платформе vk"));
        assert!(prompt.contains("автоматизация постинга"));
    }

    #[test]
    fn test_build_funnel_prompt_spin_problem_structure() {
        let prompt = build_funnel_system_prompt(
            "spin",
            "problem",
            "Дмитрий",
            "tg",
            "ручная публикация контента занимает 4 часа в день",
            false,
        );

        assert!(prompt.contains("[ПРАВИЛА ВОРОНКИ (SPIN)]"));
        // Check SPIN Problem contract text
        assert!(prompt.contains("Задай проблемный вопрос лиду Дмитрий, опираясь на контекст: ручная публикация контента занимает 4 часа в день"));
        assert!(prompt.contains("Цель: заставить человека задуматься о неэффективности его текущих методов. Без приветствия, продолжай диалог."));
        // Humanizer disabled
        assert!(!prompt.contains("HUMANIZATION RULES:"));
    }

    #[test]
    fn test_nameless_lead_adaptation() {
        let nameless_variants = ["", "   ", "No Name", "no name", "noname", "Без имени", "unknown"];

        for variant in nameless_variants {
            assert!(is_nameless(variant), "Should detect '{}' as nameless", variant);

            let prompt = build_funnel_system_prompt(
                "aida",
                "attention",
                variant,
                "vk",
                "маркетинг",
                false,
            );

            assert!(
                prompt.contains("КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать 'Привет, No Name'"),
                "Prompt must strictly prohibit 'No Name' greeting for '{}'",
                variant
            );
            assert!(
                !prompt.contains("лида No Name"),
                "Prompt should not format lead name as 'No Name'"
            );
        }
    }

    #[test]
    fn test_clean_generated_funnel_message_removes_quotes_and_prefixes() {
        let raw = r#"Вот ваш вариант:
"Привет! Видел твои кейсы по SMM. Как сейчас автоматизируете публикации?""#;

        let cleaned = clean_generated_funnel_message(raw, "Алексей");
        assert_eq!(
            cleaned,
            "Привет! Видел твои кейсы по SMM. Как сейчас автоматизируете публикации?"
        );
    }

    #[test]
    fn test_clean_generated_funnel_message_removes_markdown_code_fences() {
        let raw = "```\nЗдравствуйте, Михаил! Подскажите, сталкивались ли с блокировками при масс-постинге?\n```";
        let cleaned = clean_generated_funnel_message(raw, "Михаил");
        assert_eq!(
            cleaned,
            "Здравствуйте, Михаил! Подскажите, сталкивались ли с блокировками при масс-постинге?"
        );
    }

    #[test]
    fn test_clean_generated_funnel_message_replaces_placeholders() {
        let raw = "Добрый день, [Имя]! Как вы сейчас решаете задачу сбора заявок?";
        let cleaned = clean_generated_funnel_message(raw, "Ольга");
        assert_eq!(
            cleaned,
            "Добрый день, Ольга! Как вы сейчас решаете задачу сбора заявок?"
        );
    }

    #[test]
    fn test_clean_generated_funnel_message_nameless_placeholder_removal() {
        let raw = "Привет, [Имя]! Вижу ваш интерес к автоматизации.";
        let cleaned = clean_generated_funnel_message(raw, "No Name");
        assert_eq!(cleaned, "Привет! Вижу ваш интерес к автоматизации.");
    }
}
