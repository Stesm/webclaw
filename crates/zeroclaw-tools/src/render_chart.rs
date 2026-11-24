use async_trait::async_trait;
use serde_json::{Map, Value, json};
use zeroclaw_api::tool::{Tool, ToolOutput, ToolResult};

const MAX_POINTS: usize = 500;
const MAX_SERIES: usize = 6;
const CHART_TYPES: [&str; 4] = ["line", "area", "bar", "pie"];

/// Renders an inline chart in the web chat.
///
/// The tool owns validation and the wire format: it turns the model's rows
/// into one canonical ```` ```chart ```` block. The gateway appends that block
/// to the turn's final assistant message, and the dashboard draws it with
/// ECharts, so the model never has to hand-write the JSON.
pub struct RenderChartTool;

impl RenderChartTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RenderChartTool {
    fn default() -> Self {
        Self::new()
    }
}

fn invalid(message: impl Into<String>) -> ToolResult {
    ToolResult {
        success: false,
        output: ToolOutput::default(),
        error: Some(message.into()),
    }
}

fn normalized_spec(args: &Value) -> Result<Value, String> {
    let object = args
        .as_object()
        .ok_or_else(|| "arguments must be an object".to_string())?;

    let chart_type = match object.get("type") {
        None | Some(Value::Null) => "line".to_string(),
        Some(Value::String(value)) if CHART_TYPES.contains(&value.as_str()) => value.clone(),
        Some(Value::String(value)) => {
            return Err(format!(
                "unsupported chart type `{value}`; use one of {}",
                CHART_TYPES.join(", ")
            ));
        }
        Some(_) => return Err("`type` must be a string".to_string()),
    };

    let x = object
        .get("x")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing required parameter: x (name of the label field)".to_string())?
        .to_string();

    let raw_series = object
        .get("series")
        .and_then(Value::as_array)
        .filter(|series| !series.is_empty())
        .ok_or_else(|| "missing required parameter: series (non-empty array)".to_string())?;
    if raw_series.len() > MAX_SERIES {
        return Err(format!(
            "too many series: {} (max {MAX_SERIES})",
            raw_series.len()
        ));
    }

    let mut series = Vec::with_capacity(raw_series.len());
    let mut keys = Vec::with_capacity(raw_series.len());
    for (index, entry) in raw_series.iter().enumerate() {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("series[{index}] must be an object"))?;
        let key = entry
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("series[{index}].key is required"))?;
        if keys.iter().any(|existing| existing == key) {
            return Err(format!("duplicate series key `{key}`"));
        }
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| key.to_string());
        keys.push(key.to_string());
        series.push(json!({ "key": key, "name": name }));
    }

    let raw_data = object
        .get("data")
        .and_then(Value::as_array)
        .filter(|data| !data.is_empty())
        .ok_or_else(|| "missing required parameter: data (non-empty array of rows)".to_string())?;
    if raw_data.len() > MAX_POINTS {
        return Err(format!(
            "too many rows: {} (max {MAX_POINTS})",
            raw_data.len()
        ));
    }

    let mut data = Vec::with_capacity(raw_data.len());
    for (index, row) in raw_data.iter().enumerate() {
        let row = row
            .as_object()
            .ok_or_else(|| format!("data[{index}] must be an object"))?;
        let label = row
            .get(&x)
            .ok_or_else(|| format!("data[{index}] is missing `{x}`"))?;
        if !matches!(label, Value::String(_) | Value::Number(_)) {
            return Err(format!("data[{index}].{x} must be a string or number"));
        }
        let mut normalized = Map::with_capacity(keys.len() + 1);
        normalized.insert(x.clone(), label.clone());
        for key in &keys {
            match row.get(key) {
                None | Some(Value::Null) => {
                    normalized.insert(key.clone(), Value::Null);
                }
                Some(Value::Number(number)) => {
                    normalized.insert(key.clone(), Value::Number(number.clone()));
                }
                Some(_) => {
                    return Err(format!("data[{index}].{key} must be a number or null"));
                }
            }
        }
        data.push(Value::Object(normalized));
    }

    let mut spec = Map::with_capacity(5);
    spec.insert("type".to_string(), Value::String(chart_type));
    if let Some(title) = object
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        spec.insert("title".to_string(), Value::String(title.to_string()));
    }
    spec.insert("x".to_string(), Value::String(x));
    spec.insert("series".to_string(), Value::Array(series));
    spec.insert("data".to_string(), Value::Array(data));
    Ok(Value::Object(spec))
}

#[async_trait]
impl Tool for RenderChartTool {
    fn name(&self) -> &str {
        "render_chart"
    }

    fn description(&self) -> &str {
        "Render a chart inline in the web chat reply. Use it whenever the user asks to show, plot \
         or compare data over time or by category and you have the numbers: visibility, traffic, \
         positions, spend, counts. Pass the rows you already have; the tool validates them and \
         returns the chart block, which the dashboard draws automatically. Prefer one chart per \
         answer, and do not paste the JSON or the block yourself."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": CHART_TYPES,
                    "description": "line — trend over time (smoothed), area — accumulating trend with fill, \
                        bar — distribution across categories, pie — share of a total. Default: line."
                },
                "title": {
                    "type": "string",
                    "description": "Short caption shown above the chart."
                },
                "x": {
                    "type": "string",
                    "description": "Name of the label field present in every data row (e.g. date or name)."
                },
                "series": {
                    "type": "array",
                    "description": "One entry per plotted value, max 6.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": { "type": "string", "description": "Field name in each data row." },
                            "name": { "type": "string", "description": "Legend label. Defaults to key." }
                        },
                        "required": ["key"]
                    }
                },
                "data": {
                    "type": "array",
                    "description": "Rows, max 500. Each row holds the label field and one numeric field per series key.",
                    "items": { "type": "object" }
                }
            },
            "required": ["x", "series", "data"]
        })
    }

    fn output_schema(&self) -> Option<Value> {
        Some(json!({
            "type": "object",
            "properties": {
                "chart": {
                    "type": "object",
                    "description": "Canonical chart specification, identical to the rendered block."
                }
            },
            "required": ["chart"]
        }))
    }

    async fn execute(&self, args: Value) -> anyhow::Result<ToolResult> {
        let spec = match normalized_spec(&args) {
            Ok(spec) => spec,
            Err(message) => return Ok(invalid(message)),
        };
        let body = serde_json::to_string(&spec).unwrap_or_else(|_| spec.to_string());
        Ok(ToolResult {
            success: true,
            output: ToolOutput::json_with_text(
                json!({ "chart": spec }),
                format!("```chart\n{body}\n```"),
            ),
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(args: Value) -> ToolResult {
        RenderChartTool::new().execute(args).await.unwrap()
    }

    #[tokio::test]
    async fn returns_a_canonical_chart_block() {
        let result = run(json!({
            "type": "area",
            "title": "Видимость",
            "x": "date",
            "series": [{ "key": "visibility", "name": "Видимость" }],
            "data": [
                { "date": "01.09", "visibility": 42 },
                { "date": "01.10", "visibility": 47 }
            ]
        }))
        .await;

        assert!(result.success, "{:?}", result.error);
        let text = result.output.as_str();
        assert!(text.starts_with("```chart\n"), "{text}");
        assert!(text.ends_with("\n```"), "{text}");
        let body = text
            .trim_start_matches("```chart\n")
            .trim_end_matches("\n```");
        let spec: Value = serde_json::from_str(body).unwrap();
        assert_eq!(spec["type"], "area");
        assert_eq!(spec["series"][0]["name"], "Видимость");
        assert_eq!(spec["data"][1]["visibility"], 47);
    }

    #[tokio::test]
    async fn defaults_type_and_legend_name_and_keeps_gaps() {
        let result = run(json!({
            "x": "day",
            "series": [{ "key": "visits" }],
            "data": [{ "day": "mon", "visits": 3 }, { "day": "tue" }]
        }))
        .await;

        assert!(result.success, "{:?}", result.error);
        let data = result.output.data().unwrap();
        assert_eq!(data["chart"]["type"], "line");
        assert_eq!(data["chart"]["series"][0]["name"], "visits");
        assert_eq!(data["chart"]["data"][1]["visits"], Value::Null);
    }

    #[tokio::test]
    async fn keeps_only_the_fields_the_chart_needs() {
        let result = run(json!({
            "x": "date",
            "series": [{ "key": "value" }],
            "data": [{ "date": "01.09", "value": 1, "noise": "drop me" }]
        }))
        .await;

        assert!(result.success);
        let data = result.output.data().unwrap();
        assert_eq!(
            data["chart"]["data"][0],
            json!({ "date": "01.09", "value": 1 })
        );
    }

    #[tokio::test]
    async fn rejects_unknown_type_missing_fields_and_bad_values() {
        for (args, expected) in [
            (
                json!({ "type": "radar", "x": "d", "series": [{ "key": "v" }], "data": [{ "d": "1", "v": 1 }] }),
                "unsupported chart type",
            ),
            (
                json!({ "series": [{ "key": "v" }], "data": [{ "d": "1", "v": 1 }] }),
                "missing required parameter: x",
            ),
            (
                json!({ "x": "d", "series": [], "data": [{ "d": "1" }] }),
                "missing required parameter: series",
            ),
            (
                json!({ "x": "d", "series": [{ "key": "v" }], "data": [] }),
                "missing required parameter: data",
            ),
            (
                json!({ "x": "d", "series": [{ "key": "v" }], "data": [{ "v": 1 }] }),
                "is missing `d`",
            ),
            (
                json!({ "x": "d", "series": [{ "key": "v" }], "data": [{ "d": "1", "v": "high" }] }),
                "must be a number or null",
            ),
        ] {
            let result = run(args).await;
            assert!(!result.success, "expected a rejection");
            assert!(
                result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains(expected),
                "unexpected error: {:?}",
                result.error
            );
        }
    }
}
