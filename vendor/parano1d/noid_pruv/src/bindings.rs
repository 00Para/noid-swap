// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Paranoid Zero.

use serde::de::{MapAccess, Visitor};
use serde::Deserializer;
use serde_json::{Map, Value};

use crate::{Error, MAX_SOURCE_BYTES};

struct Parameters;

impl<'de> Visitor<'de> for Parameters {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a parameter object with distinct names")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut entries: M) -> Result<Value, M::Error> {
        let mut values = Map::new();
        while let Some((name, value)) = entries.next_entry::<String, Value>()? {
            if values.insert(name.clone(), value).is_some() {
                return Err(serde::de::Error::custom(format!(
                    "duplicate parameter '{name}'"
                )));
            }
        }
        Ok(Value::Object(values))
    }
}

/// Parse a bounded parameter object without silently replacing duplicate keys.
pub fn parse_parameters(text: &str) -> Result<Value, Error> {
    if text.len() > MAX_SOURCE_BYTES {
        return Err(Error::plain("parameters exceed 64 KiB"));
    }
    let mut decoder = serde_json::Deserializer::from_str(text);
    let value = decoder
        .deserialize_map(Parameters)
        .map_err(|error| Error::plain(error.to_string()))?;
    decoder
        .end()
        .map_err(|error| Error::plain(error.to_string()))?;
    Ok(value)
}
