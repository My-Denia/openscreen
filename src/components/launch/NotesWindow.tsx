import React, { useLayoutEffect, useState } from "react";

export function NotesWindow() {
	const [notes, setNotes] = useState("");

	const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		localStorage.setItem("notes", e.target.value);
		setNotes(e.target.value);
	};

	useLayoutEffect(() => {
		setNotes(localStorage.getItem("notes") ?? "");
	}, []);

	return (
		<div className="bg-white h-screen w-screen px-6 py-4">
			<textarea
				className="w-full h-full bg-transparent outline-none resize-none caret-black text-black"
				placeholder="Take notes here..."
				value={notes}
				onChange={handleNotesChange}
			/>
		</div>
	);
}
