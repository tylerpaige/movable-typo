//! Uploads to Typo School's Economy (Api::ReadingsController in
//! typo-school-backend). Done here, not in the webview, because Economy's
//! CORS only admits the course sites.

use crate::files::{Settings, err};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Duration;

/// The reading as Economy saved it, and whether this upload created it.
#[derive(Serialize, Debug)]
pub struct Saved {
    pub created: bool,
    pub reading: Value,
}

pub struct Economy {
    client: Client,
    base: Url,
    key: String,
}

impl Economy {
    pub fn new(s: &Settings) -> Result<Self, String> {
        let key = s.economy_api_key.trim();
        if key.is_empty() {
            return Err("There's no Typo School API key yet. Add it in Settings.".into());
        }
        let base = Url::parse(s.economy_url.trim()).map_err(|e| format!("Typo School URL: {e}"))?;
        // A PDF can be large and the connection slow.
        let client = Client::builder().timeout(Duration::from_secs(300)).build().map_err(err)?;
        Ok(Economy { client, base, key: key.into() })
    }

    /// `segments` are appended to /api/readings, percent-encoded.
    fn request(&self, method: Method, segments: &[&str]) -> Result<RequestBuilder, String> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| "Typo School URL can't have paths".to_string())?
            .pop_if_empty()
            .extend(["api", "readings"])
            .extend(segments);
        Ok(self.client.request(method, url).bearer_auth(&self.key))
    }

    /// Stores one image and returns its public URL. `data` is base64.
    pub async fn upload_image(&self, slug: &str, name: &str, mime: &str, data: &str) -> Result<String, String> {
        let bytes = BASE64.decode(data.trim()).map_err(err)?;
        let res = self.request(Method::PUT, &[slug, "images", name])?.header("Content-Type", mime).body(bytes);
        let body = json_of(send(res).await?).await?;
        body["url"].as_str().map(String::from).ok_or_else(|| "Typo School didn't return the image's URL".into())
    }

    /// Updates the reading with this slug, or creates it (unpublished) if there's none.
    pub async fn save_reading(&self, slug: &str, reading: Value) -> Result<Saved, String> {
        let body = json!({ "reading": reading });
        let res = send(self.request(Method::PATCH, &[slug])?.json(&body)).await?;
        if res.status() != StatusCode::NOT_FOUND {
            return Ok(Saved { created: false, reading: json_of(res).await?["reading"].take() });
        }
        let mut body = body;
        body["reading"]["slug"] = slug.into();
        let res = send(self.request(Method::POST, &[])?.json(&body)).await?;
        Ok(Saved { created: true, reading: json_of(res).await?["reading"].take() })
    }

    /// Replaces the reading's PDF. The reading has to exist.
    pub async fn upload_pdf(&self, slug: &str, pdf: Vec<u8>) -> Result<(), String> {
        let res = self.request(Method::PUT, &[slug, "pdf"])?.header("Content-Type", "application/pdf").body(pdf);
        json_of(send(res).await?).await.map(|_| ())
    }
}

async fn send(req: RequestBuilder) -> Result<Response, String> {
    req.send().await.map_err(|e| format!("Couldn't reach Typo School: {e}"))
}

/// The response's JSON, or its error as a sentence. A 404 passes through for save_reading.
async fn json_of(res: Response) -> Result<Value, String> {
    let status = res.status();
    let text = res.text().await.map_err(err)?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    Err(error_message(status, &body))
}

/// `{ error }` from the file endpoints and auth, or `{ field: [messages] }` from validation.
fn error_message(status: StatusCode, body: &Value) -> String {
    if status == StatusCode::UNAUTHORIZED {
        return "Typo School didn't accept the API key. Check it in Settings.".into();
    }
    if let Some(e) = body["error"].as_str() {
        return e.into();
    }
    if let Some(fields) = body.as_object().filter(|o| !o.is_empty()) {
        let parts: Vec<String> = fields
            .iter()
            .flat_map(|(field, msgs)| {
                let msgs = msgs.as_array().cloned().unwrap_or_default();
                msgs.into_iter().filter_map(move |m| m.as_str().map(|m| format!("{field} {m}")))
            })
            .collect();
        if !parts.is_empty() {
            return parts.join("; ");
        }
    }
    format!("Typo School answered {status}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages() {
        let validation = json!({ "slug": ["has already been taken"], "title": ["can't be blank"] });
        assert_eq!(error_message(StatusCode::UNPROCESSABLE_ENTITY, &validation), "slug has already been taken; title can't be blank");
        assert_eq!(error_message(StatusCode::UNPROCESSABLE_ENTITY, &json!({ "error": "Bad type" })), "Bad type");
        assert!(error_message(StatusCode::UNAUTHORIZED, &json!({ "error": "Unauthorized" })).contains("API key"));
        assert_eq!(error_message(StatusCode::BAD_GATEWAY, &Value::Null), "Typo School answered 502 Bad Gateway");
    }

    #[test]
    fn urls_are_built_under_the_base() {
        let mut s = Settings::defaults(std::path::Path::new("/h"));
        s.economy_api_key = "k".into();
        s.economy_url = "http://localhost:3100/".into();
        let e = Economy::new(&s).unwrap();
        let req = e.request(Method::PUT, &["essay", "images", "fig 1.png"]).unwrap().build().unwrap();
        assert_eq!(req.url().as_str(), "http://localhost:3100/api/readings/essay/images/fig%201.png");
        s.economy_api_key = " ".into();
        assert!(Economy::new(&s).is_err());
    }
}
