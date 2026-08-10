"""Reader backends for activation projections and logit-lens outputs."""

from __future__ import annotations

import hashlib
import importlib.util
from dataclasses import dataclass
from typing import Any

from repeng_contract import ContractError, deterministic_text_vector, dot_product, vector_norm

from reader.contract import ControlVector, JsonObject, ReaderScenario


FIXTURE_LOGIT_TOKENS = (
    " joy",
    " sadness",
    " fear",
    " anger",
    " trust",
    " control",
    " avoid",
    " approach",
    " neutral",
    " honest",
    " uncertain",
    " calm",
)


@dataclass(frozen=True)
class ProjectionMeasurement:
    score: float
    hidden_norm: float


class FixtureReaderBackend:
    name = "fixture"

    def __init__(self, *, training: JsonObject) -> None:
        if training.get("backend") != "fixture":
            raise ContractError("fixture reader backend requires a fixture-trained artifact")
        seed = training.get("seed")
        vector_dim = training.get("vectorDim")
        if not isinstance(seed, int):
            raise ContractError("fixture reader backend requires integer training.seed")
        if not isinstance(vector_dim, int) or vector_dim <= 0:
            raise ContractError("fixture reader backend requires positive integer training.vectorDim")
        self.seed = seed
        self.vector_dim = vector_dim
        self.model_id = str(training["modelId"])

    def prepare_scenario(
        self,
        *,
        scenario: ReaderScenario,
        layers: list[int],
        projection_pool: str,
    ) -> None:
        return None

    def project(
        self,
        *,
        prepared: None,
        scenario: ReaderScenario,
        control_vector: ControlVector,
        projection_pool: str,
    ) -> ProjectionMeasurement:
        if control_vector.dim != self.vector_dim:
            raise ContractError(
                f"{control_vector.axis_id} layer {control_vector.layer}: vector dim does not match fixture training.vectorDim"
            )
        hidden = deterministic_text_vector(
            text=scenario.prompt,
            axis_id=control_vector.axis_id,
            layer=control_vector.layer,
            vector_dim=self.vector_dim,
            seed=self.seed,
            model_id=self.model_id,
        )
        return ProjectionMeasurement(
            score=dot_product(control_vector.vector, hidden),
            hidden_norm=vector_norm(hidden),
        )

    def logit_lens(
        self,
        *,
        prepared: None,
        scenario: ReaderScenario,
        layers: list[int],
        top_k: int,
    ) -> list[JsonObject]:
        records = []
        for layer in layers:
            scored = [
                {
                    "tokenId": token_id,
                    "token": token,
                    "score": deterministic_fixture_logit(
                        model_id=self.model_id,
                        scenario_id=scenario.id,
                        prompt=scenario.prompt,
                        layer=layer,
                        token=token,
                    ),
                }
                for token_id, token in enumerate(FIXTURE_LOGIT_TOKENS)
            ]
            top_tokens = sorted(scored, key=lambda entry: (-entry["score"], entry["tokenId"]))[:top_k]
            for rank, token in enumerate(top_tokens, start=1):
                token["rank"] = rank
            records.append({
                "scenarioId": scenario.id,
                "layer": layer,
                "topTokens": top_tokens,
            })
        return records


class TransformersReaderBackend:
    name = "transformers"

    def __init__(
        self,
        *,
        model_id: str,
        model_cache: str | None,
        trust_remote_code: bool,
        dtype: str,
    ) -> None:
        require_modules(("accelerate", "torch", "transformers"))
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        dtype_by_name = {
            "bfloat16": torch.bfloat16,
            "float16": torch.float16,
            "float32": torch.float32,
        }
        torch_dtype = dtype_by_name.get(dtype)
        if torch_dtype is None:
            raise ContractError(f"unsupported Transformers dtype: {dtype}")

        tokenizer_kwargs: dict[str, Any] = {"trust_remote_code": trust_remote_code}
        model_kwargs: dict[str, Any] = {
            "dtype": torch_dtype,
            "device_map": "auto",
            "trust_remote_code": trust_remote_code,
            "low_cpu_mem_usage": True,
        }
        if model_cache is not None:
            tokenizer_kwargs["cache_dir"] = model_cache
            model_kwargs["cache_dir"] = model_cache

        self.tokenizer = AutoTokenizer.from_pretrained(model_id, **tokenizer_kwargs)
        self.model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)
        self.model.eval()
        self.model_id = model_id
        self.device = next(self.model.parameters()).device

    def prepare_scenario(
        self,
        *,
        scenario: ReaderScenario,
        layers: list[int],
        projection_pool: str,
    ) -> JsonObject:
        import torch

        inputs = self.tokenizer(scenario.prompt, return_tensors="pt")
        inputs = {name: value.to(self.device) for name, value in inputs.items()}
        with torch.inference_mode():
            outputs = self.model(**inputs, output_hidden_states=True, use_cache=False)
        hidden_states = outputs.hidden_states
        if not hidden_states:
            raise ContractError("Transformers returned no hidden states")
        for layer in layers:
            if layer >= len(hidden_states):
                raise ContractError(f"requested layer {layer}, but model returned {len(hidden_states)} hidden-state entries")
        return {
            "inputs": inputs,
            "hiddenStates": hidden_states,
            "pooledByLayer": {},
        }

    def project(
        self,
        *,
        prepared: JsonObject,
        scenario: ReaderScenario,
        control_vector: ControlVector,
        projection_pool: str,
    ) -> ProjectionMeasurement:
        hidden = pooled_hidden(prepared, control_vector.layer, projection_pool)
        hidden_values = [float(value) for value in hidden.detach().float().cpu().tolist()]
        if len(hidden_values) != control_vector.dim:
            raise ContractError(
                f"{control_vector.axis_id} layer {control_vector.layer}: hidden dim "
                f"{len(hidden_values)} does not match control-vector dim {control_vector.dim}"
            )
        return ProjectionMeasurement(
            score=dot_product(control_vector.vector, hidden_values),
            hidden_norm=vector_norm(hidden_values),
        )

    def logit_lens(
        self,
        *,
        prepared: JsonObject,
        scenario: ReaderScenario,
        layers: list[int],
        top_k: int,
    ) -> list[JsonObject]:
        import torch

        lm_head = getattr(self.model, "lm_head", None)
        if lm_head is None:
            raise ContractError("Transformers model does not expose lm_head for logit lens")

        records = []
        with torch.inference_mode():
            for layer in layers:
                hidden_state = prepared["hiddenStates"][layer][0]
                token_index = last_token_index(prepared["inputs"].get("attention_mask"), hidden_state.shape[0])
                hidden = hidden_state[token_index]
                logits = lm_head(hidden.unsqueeze(0)).reshape(-1).float()
                k = min(top_k, int(logits.numel()))
                values, indexes = torch.topk(logits, k=k)
                top_tokens = []
                for rank, (score, token_id) in enumerate(zip(values.tolist(), indexes.tolist()), start=1):
                    top_tokens.append({
                        "rank": rank,
                        "tokenId": int(token_id),
                        "token": self.tokenizer.decode([int(token_id)], clean_up_tokenization_spaces=False),
                        "score": float(score),
                    })
                records.append({
                    "scenarioId": scenario.id,
                    "layer": layer,
                    "topTokens": top_tokens,
                })
        return records


def pooled_hidden(prepared: JsonObject, layer: int, projection_pool: str) -> Any:
    cache_key = f"{projection_pool}:{layer}"
    cached = prepared["pooledByLayer"].get(cache_key)
    if cached is not None:
        return cached
    hidden_state = prepared["hiddenStates"][layer][0]
    attention_mask = prepared["inputs"].get("attention_mask")
    if projection_pool == "mean":
        if attention_mask is None:
            pooled = hidden_state.mean(dim=0)
        else:
            weights = attention_mask[0].to(hidden_state.dtype).unsqueeze(-1)
            token_count = weights.sum().clamp_min(1)
            pooled = (hidden_state * weights).sum(dim=0) / token_count
    elif projection_pool == "last":
        pooled = hidden_state[last_token_index(attention_mask, hidden_state.shape[0])]
    else:
        raise ContractError(f"unsupported projection pool: {projection_pool}")
    prepared["pooledByLayer"][cache_key] = pooled
    return pooled


def last_token_index(attention_mask: Any, sequence_length: int) -> int:
    if sequence_length <= 0:
        raise ContractError("cannot read hidden state from an empty sequence")
    if attention_mask is None:
        return sequence_length - 1
    nonzero = attention_mask[0].nonzero(as_tuple=False).flatten()
    if int(nonzero.numel()) == 0:
        return sequence_length - 1
    return int(nonzero[-1].item())


def deterministic_fixture_logit(
    *,
    model_id: str,
    scenario_id: str,
    prompt: str,
    layer: int,
    token: str,
) -> float:
    payload = f"{model_id}|{scenario_id}|{layer}|{token}|{prompt}".encode("utf-8")
    digest = hashlib.sha256(payload).digest()
    integer = int.from_bytes(digest[:8], byteorder="big", signed=False)
    return (integer / ((1 << 64) - 1)) * 2.0 - 1.0


def require_modules(module_names: tuple[str, ...]) -> None:
    missing = [name for name in module_names if importlib.util.find_spec(name) is None]
    if missing:
        raise ContractError(
            "transformers reader backend blocked: missing Python dependencies: "
            + ", ".join(missing)
            + ". Install the pinned stack with: python3 -m pip install -r eval/repeng/requirements-control-vectors.txt"
        )
