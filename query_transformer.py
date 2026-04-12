import re
from typing import Set

# Common English stop words to filter out during keyword extraction
STOP_WORDS: Set[str] = {
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'and', 'but', 'or', 'yet', 'so', 'if',
    'because', 'although', 'though', 'while', 'where', 'when', 'that',
    'which', 'who', 'whom', 'whose', 'what', 'this', 'these', 'those'
}

class QueryTransformer:
    def __init__(self, llm):
        """
        Initialize the QueryTransformer with an LLM instance.
        
        Args:
            llm: SmartLLM instance for generating step-back queries
        """
        self.llm = llm

    def transform_step_back(self, query: str) -> str:
        """
        Generate a more general 'step-back' query to improve retrieval.
        For example: "What is the max speed of the Ford Mustang GT?" → "Ford Mustang GT specifications"
        """
        prompt = f"""Given the following user question, generate a more general 'step-back' query that would help retrieve relevant context.
        
User Question: {query}

Step-Back Query: """
        
        # Use LLM to generate step-back query
        from llm_interface import InferenceConfig
        # 50 tokens: enough for a concise step-back query without excess
        # 0.3 temperature: low randomness for consistent, focused output
        config = InferenceConfig(max_tokens=50, temperature=0.3)
        transformed = self.llm.generate(prompt, config).strip()
        
        # If transformation failed or returned empty, return original
        if not transformed or len(transformed) < 5:
            return query
        
        return transformed

    def transform_keywords(self, query: str) -> str:
        """
        Extract key terms from query for keyword-based search.
        """
        # Simple implementation: remove stop words and keep important terms
        # Use module-level stop words constant
        words = query.lower().split()
        keywords = [w for w in words if w not in STOP_WORDS and len(w) > 2]
        return ' '.join(keywords) if keywords else query