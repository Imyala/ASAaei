import React from 'react'

// The app mark shown at the top of the home and Settings screens.
export default function Mark() {
  return (
    <span className="landing-mark" aria-hidden="true">
      <svg viewBox="0 0 44 44" width="44" height="44">
        <rect x="8" y="4" width="24" height="32" rx="4" fill="#fff" stroke="#c6d0e4" strokeWidth="1.5" />
        <rect x="13" y="11" width="14" height="2.4" rx="1.2" fill="#3b57a6" />
        <rect x="13" y="17" width="14" height="2.4" rx="1.2" fill="#c9d3e6" />
        <rect x="13" y="23" width="9" height="2.4" rx="1.2" fill="#c9d3e6" />
        <path d="M25 30.5 l9.5-9.5 3.5 3.5-9.5 9.5-4.6 1.1z"
          fill="#e8eefb" stroke="#3b57a6" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </span>
  )
}
