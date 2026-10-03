# Semantic operations

Read this page before embedding, reranking, classifying, or deduplicating text.

## Embed

```bash
jina embed "hello world"
jina embed "text1" "text2" "text3"
cat texts.txt | jina embed --json
jina embed "hello" --model jina-embeddings-v5-text-small --task retrieval.query
```

## Rerank

```bash
cat docs.txt | jina rerank "machine learning"
jina search "AI" | jina rerank "embeddings" --top-n 5
```

## Classify

```bash
jina classify "I love this product" --labels positive,negative,neutral
echo "stock prices rose sharply" | jina classify --labels business,sports,tech
cat texts.txt | jina classify --labels cat1,cat2,cat3 --json
```

## Deduplicate text

```bash
cat items.txt | jina dedup
cat items.txt | jina dedup -k 10
```
