"""LangGraph workflows pour les 3 agents autonomes.

Pattern commun (mitigation Qwen2.5-7B) :
- 1 nœud = 1 outil exposé au LLM (réduit l'espace de décision)
- Chaque nœud renvoie un dict typé Pydantic (validation stricte)
- Les transitions sont DÉTERMINISTES (pas de routing libre par le LLM)
- Pas de boucle ReAct libre — workflow figé en DAG
- Checkpoint Postgres pour reprise après crash (long-running)
"""
