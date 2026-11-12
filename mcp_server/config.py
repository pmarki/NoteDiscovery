"""
Configuration management for the MCP server.

Handles environment variables and provides validated configuration.
"""

import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse


@dataclass(frozen=True)
class MCPConfig:
    """Immutable configuration for the MCP server."""
    
    base_url: str
    api_key: Optional[str]
    timeout: float
    max_retries: int
    
    def __post_init__(self) -> None:
        """Validate configuration after initialization."""
        # Validate URL format
        parsed = urlparse(self.base_url)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"Invalid KEEPIT_URL: {self.base_url}")
        
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"URL must use http or https: {self.base_url}")
    
    @property
    def headers(self) -> dict[str, str]:
        """Get HTTP headers for API requests."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "KeepIt-MCP/1.0",
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers


def load_config() -> MCPConfig:
    """
    Load configuration from environment variables.
    
    Environment Variables:
        KEEPIT_URL: Server URL (default: http://localhost:8000)
        KEEPIT_API_KEY: API key for authentication (optional)
        KEEPIT_TIMEOUT: Request timeout in seconds (default: 30)
        KEEPIT_MAX_RETRIES: Max retry attempts (default: 3)
    
    Returns:
        MCPConfig: Validated configuration object
        
    Raises:
        ValueError: If configuration is invalid
    """
    base_url = os.getenv("KEEPIT_URL", "http://localhost:8000").rstrip("/")
    api_key = os.getenv("KEEPIT_API_KEY", "").strip() or None
    
    try:
        timeout = float(os.getenv("KEEPIT_TIMEOUT", "30"))
    except ValueError:
        timeout = 30.0
    
    try:
        max_retries = int(os.getenv("KEEPIT_MAX_RETRIES", "3"))
    except ValueError:
        max_retries = 3
    
    return MCPConfig(
        base_url=base_url,
        api_key=api_key,
        timeout=timeout,
        max_retries=max_retries,
    )
